import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

type Entry = {
  id: string;
  subject: string;
  category: string;
  region: string;
  group: string;
  questions: number;
};

// Parsing every quiz on each request means ~23 MB of JSON, which blows the
// caller's timeout. Hold the catalogue in memory and rebuild it only when the
// directory actually changes, so a newly created quiz still shows up quickly.
let cache: { key: string; at: number; data: Entry[] } | null = null;
const TTL_MS = 60000;

function directoryKey(dir: string): string {
  const stat = fs.statSync(dir);
  const count = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length;
  return `${stat.mtimeMs}:${count}`;
}

export async function GET() {
  try {
    // Next runs from /app/packages/web inside the container, same as the
    // report route, so config lives two levels up.
    const dir = path.join(process.cwd(), '../../config/quizz');

    if (!fs.existsSync(dir)) {
      return NextResponse.json({ error: 'Quiz directory not found' }, { status: 404 });
    }

    const key = directoryKey(dir);
    if (cache && cache.key === key && Date.now() - cache.at < TTL_MS) {
      return NextResponse.json(cache.data);
    }

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const data: Entry[] = [];

    for (const file of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
        const subject =
          typeof raw.subject === 'string' && raw.subject.trim()
            ? raw.subject.trim()
            : file.replace(/\.json$/, '');

        // The identifier is the file name including .json, which is what
        // Config.quizz() yields and what /solo/<id> expects.
        data.push({
          id: file,
          subject,
          category: typeof raw.category === 'string' ? raw.category : '',
          region: typeof raw.region === 'string' ? raw.region : '',
          group: typeof raw.group === 'string' ? raw.group : '',
          questions: Array.isArray(raw.questions) ? raw.questions.length : 0,
        });
      } catch {
        // One malformed quiz must not take the whole catalogue down.
      }
    }

    data.sort((a, b) => a.subject.localeCompare(b.subject));

    cache = { key, at: Date.now(), data };

    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: 'Server error: ' + error.message }, { status: 500 });
  }
}
