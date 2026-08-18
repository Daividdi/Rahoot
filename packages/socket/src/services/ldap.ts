import { createConnection } from 'net'

const LDAP_URL   = process.env.LDAP_URL   || ''
const LDAP_DOMAIN = process.env.LDAP_DOMAIN || ''
const LDAP_SEARCH_BASE = process.env.LDAP_SEARCH_BASE || ''
const LDAP_SVC_USER = process.env.LDAP_SERVICE_USER || ''
const LDAP_SVC_PASS = process.env.LDAP_SERVICE_PASS || ''

// ── Minimal async LDAP client ─────────────────────────────────────────────
// We only need BindRequest + SearchRequest, so we implement them inline
// rather than pulling in a full LDAP library (avoids ESM/CJS bundling edge cases).

function parseHost(url: string): { host: string; port: number } {
  const m = url.replace(/^ldaps?:\/\//, '').match(/^([^:]+)(?::(\d+))?$/)
  return { host: m?.[1] ?? '', port: Number(m?.[2] ?? 389) }
}

// BER/ASN.1 helpers ──────────────────────────────────────────────────────────
function berLen(n: number): Buffer {
  if (n < 128) return Buffer.from([n])
  if (n < 256) return Buffer.from([0x81, n])
  return Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff])
}

function berSeq(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), berLen(content.length), content])
}

function berOctet(s: string): Buffer {
  const b = Buffer.from(s, 'utf8')
  return Buffer.concat([Buffer.from([0x04]), berLen(b.length), b])
}

function berInt(n: number): Buffer {
  return Buffer.from([0x02, 0x01, n])
}

// Build an LDAPMessage envelope
function ldapMsg(msgId: number, appTag: number, appContent: Buffer): Buffer {
  const app = berSeq(0x60 | appTag, appContent)
  const seq = berSeq(0x30, Buffer.concat([berInt(msgId), app]))
  return seq
}

// BindRequest (tag 0) — simple auth
function buildBind(msgId: number, dn: string, pass: string): Buffer {
  const ver = berInt(3)
  const name = berOctet(dn)
  const auth = Buffer.concat([Buffer.from([0x80]), berLen(Buffer.byteLength(pass, 'utf8')), Buffer.from(pass, 'utf8')])
  return ldapMsg(msgId, 0, Buffer.concat([ver, name, auth]))
}

// SearchRequest (tag 3) — search for sAMAccountName
function buildSearch(msgId: number, base: string, filter: string, attrs: string[]): Buffer {
  const baseOctet = berOctet(base)
  const scope     = Buffer.from([0x0a, 0x01, 0x02])   // wholeSubtree
  const deref     = Buffer.from([0x0a, 0x01, 0x00])
  const sizeLimit = berInt(0)
  const timeLimit = Buffer.from([0x02, 0x01, 0x1e])    // 30 s
  const typesOnly = Buffer.from([0x01, 0x01, 0x00])
  // Simple equality filter: (sAMAccountName=<value>)
  const attrName  = berOctet('sAMAccountName')
  const attrVal   = berOctet(filter)
  const eqFilter  = berSeq(0xa3, Buffer.concat([attrName, attrVal]))
  // AttributeDescriptionList
  const attrList  = Buffer.concat(attrs.map(a => berOctet(a)))
  const attrSeq   = berSeq(0x30, attrList)
  return ldapMsg(msgId, 3, Buffer.concat([baseOctet, scope, deref, sizeLimit, timeLimit, typesOnly, eqFilter, attrSeq]))
}

// UnbindRequest (tag 2)
function buildUnbind(msgId: number): Buffer {
  return ldapMsg(msgId, 2, Buffer.alloc(0))
}

// ── Low-level socket I/O ─────────────────────────────────────────────────────

type LdapConn = { write: (b: Buffer) => void; read: () => Promise<Buffer>; destroy: () => void }

function withTimeout<T>(ms: number, p: Promise<T>, msg: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(msg)), ms))])
}

function connect(host: string, port: number): Promise<LdapConn> {
  return withTimeout(6000, new Promise((resolve, reject) => {
    const sock = createConnection({ host, port })
    const chunks: Buffer[] = []
    let waiting: ((b: Buffer) => void) | null = null

    sock.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      if (waiting) { const w = waiting; waiting = null; w(Buffer.concat(chunks.splice(0))) }
    })
    sock.on('error', reject)
    sock.on('connect', () => {
      resolve({
        write: (b) => sock.write(b),
        read: () => withTimeout(8000,
          new Promise<Buffer>(res => {
            if (chunks.length) { res(Buffer.concat(chunks.splice(0))); return }
            waiting = res
          }),
          'LDAP read timeout'
        ),
        destroy: () => sock.destroy(),
      })
    })
  }), 'LDAP connect timeout')
}

// Parse result code from an LDAPMessage response
function parseResultCode(buf: Buffer): number {
  // Walk past: 0x30 len msgId app-tag len → result-code at ~offset 7-9
  let i = 0
  if (buf[i++] !== 0x30) return 255
  // skip outer length (1-3 bytes)
  if (buf[i] & 0x80) i += (buf[i] & 0x7f) + 1; else i++
  // skip messageID (0x02 0x01 n)
  i += 3
  // skip app tag + length
  i++
  if (buf[i] & 0x80) i += (buf[i] & 0x7f) + 1; else i++
  // result code is 0x0a 0x01 <code>
  if (buf[i] === 0x0a && buf[i + 1] === 0x01) return buf[i + 2]
  return 255
}

// Parse first displayName from SearchResultEntry
function parseDisplayName(buf: Buffer): string | null {
  // Look for the string 'displayName' in the buffer then grab the value after it
  const marker = Buffer.from('displayName')
  let pos = buf.indexOf(marker)
  if (pos < 0) return null
  pos += marker.length
  // skip attribute value set tag (0x31) + length
  if (buf[pos] !== 0x31) return null
  pos++
  if (buf[pos] & 0x80) pos += (buf[pos] & 0x7f) + 1; else pos++
  // octet string tag 0x04 + length + value
  if (buf[pos] !== 0x04) return null
  pos++
  let vlen = 0
  if (buf[pos] & 0x80) {
    const lb = buf[pos] & 0x7f; pos++
    for (let j = 0; j < lb; j++) { vlen = (vlen << 8) | buf[pos++] }
  } else { vlen = buf[pos++] }
  return buf.slice(pos, pos + vlen).toString('utf8')
}


// Shorten a display name to fit the 20-char username limit.
// Strategy: First [M.] Last  →  First Last  →  hard slice
const PARTICLES = new Set(['de','da','do','dos','das','e','di','del','van','von'])
function abbreviateForUsername(name: string, max = 20): string {
  name = name.trim()
  if (name.length <= max) return name
  const parts = name.split(/\s+/).filter(Boolean)
  if (parts.length < 2) return name.slice(0, max)
  const first = parts[0]
  const last  = parts[parts.length - 1]
  // Collect particles that prefix the last surname
  const prefixes: string[] = []
  let i = parts.length - 2
  while (i > 0 && PARTICLES.has(parts[i].toLowerCase())) { prefixes.unshift(parts[i]); i-- }
  // Middle names (non-particle)
  const middles = parts.slice(1, parts.length - 1).filter(p => !PARTICLES.has(p.toLowerCase()))
  // Try: First [particles] Last
  const simple = [first, ...prefixes, last].join(' ')
  if (simple.length <= max) return simple
  // Try: First M. Last (first initial per middle word)
  const withInit = [first, ...middles.map(m => m[0] + '.'), last].join(' ')
  if (withInit.length <= max) return withInit
  // Try: First Last
  const bare = `${first} ${last}`
  if (bare.length <= max) return bare
  // Hard slice
  return bare.slice(0, max).trimEnd()
}

// ── Public API ───────────────────────────────────────────────────────────────

export type LdapAuthResult =
  // `account` is the sAMAccountName the user actually authenticated with. It is
  // the only stable identifier here: `fullName` is an abbreviation of the AD
  // displayName and changes whenever the AD record is corrected.
  | { ok: true;  fullName: string; account: string }
  | { ok: false; error: string }

export async function ldapAuthenticate(username: string, password: string): Promise<LdapAuthResult> {
  const { host, port } = parseHost(LDAP_URL)
  let conn: LdapConn | null = null

  try {
    conn = await connect(host, port)

    // 1. Bind as user
    const userDn = `${username}@${LDAP_DOMAIN}`
    conn.write(buildBind(1, userDn, password))
    const bindResp = await conn.read()
    const code = parseResultCode(bindResp)
    if (code !== 0) {
      conn.destroy()
      return { ok: false, error: code === 49 ? 'Invalid credentials' : 'Authentication failed' }
    }

    // 2. Search for displayName — try as authenticated user first, fall back to service account
    conn.write(buildSearch(2, LDAP_SEARCH_BASE, username, ['displayName']))
    const searchResp = await conn.read()
    let displayName = parseDisplayName(searchResp)

    // 3. If search returned nothing and we have a service account, re-bind as service and retry
    if (!displayName && LDAP_SVC_USER && LDAP_SVC_PASS) {
      conn.destroy()
      conn = await connect(host, port)
      conn.write(buildBind(3, LDAP_SVC_USER, LDAP_SVC_PASS))
      const svcResp = await conn.read()
      if (parseResultCode(svcResp) === 0) {
        conn.write(buildSearch(4, LDAP_SEARCH_BASE, username, ['displayName']))
        const r2 = await conn.read()
        displayName = parseDisplayName(r2)
      }
    }

    conn.destroy()
    return {
      ok: true,
      fullName: abbreviateForUsername(displayName || username),
      account: username.toLowerCase(),
    }
  } catch (err: any) {
    conn?.destroy()
    const msg = err?.message || ''
    if (msg.includes('timeout')) return { ok: false, error: 'Authentication service unavailable' }
    return { ok: false, error: 'Authentication error' }
  }
}
