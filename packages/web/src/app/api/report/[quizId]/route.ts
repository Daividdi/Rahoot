import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

export async function GET(request: Request, { params }: { params: Promise<{ quizId: string }> }) {
  try {
    const resolvedParams = await params;
    const quizId = resolvedParams.quizId.endsWith('.json') ? resolvedParams.quizId : resolvedParams.quizId + '.json';
    
    // O Next.js roda dentro do container na pasta /app/packages/web
    // Então voltamos duas pastas para achar o config/quizz
    const filePath = path.join(process.cwd(), '../../config/quizz', quizId);
    
    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: `Quiz file not found inside container at: ${filePath}` }, { status: 404 });
    }
    
    const rawData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    // Apply player name corrections
    const namesPath = path.join(process.cwd(), '../../config/player-names.json');
    let nameCorrections: Record<string, string> = {};
    try {
      if (fs.existsSync(namesPath)) {
        nameCorrections = JSON.parse(fs.readFileSync(namesPath, 'utf-8'));
      }
    } catch {}

    if (rawData.lastSessionStats && Object.keys(nameCorrections).length > 0) {
      rawData.lastSessionStats = rawData.lastSessionStats.map((player: any) => {
        const key = player.clientId || player.realName || player.username || '';
        if (key && nameCorrections[key]) {
          return { ...player, realName: nameCorrections[key] };
        }
        return player;
      });
    }

    // ── Turmas anteriores ────────────────────────────────────────────────
    //
    // `lastSessionStats` guarda UMA sessao: a proxima turma sobrescreve a
    // anterior no arquivo do quiz. Foi o que a Malasia relatou — reaproveitar o
    // quiz para um novo grupo apagava o resultado do grupo passado.
    //
    // Os dados nunca se perderam: cada sessao continua inteira no banco, em
    // `sessions` + `session_players`. O que faltava era o relatorio saber
    // procurar la. Entao esta rota devolve a LISTA de sessoes, e quando o
    // pedido nomeia uma delas ela e reconstruida no MESMO formato de
    // `lastSessionStats` — assim as 742 linhas da pagina do relatorio seguem
    // funcionando sem alteracao, para qualquer turma.
    const url = new URL(request.url);
    const sessaoPedida = url.searchParams.get('session');
    const idSemJson = quizId.replace(/\.json$/, '');

    try {
      const dbPath = path.join(process.cwd(), '../../config/rahoot.db');
      if (fs.existsSync(dbPath)) {
        // Somente leitura: este processo nunca escreve no banco do jogo.
        const db = new DatabaseSync(dbPath, { readOnly: true });

        rawData.sessions = db.prepare(
          `SELECT s.id, s.started_at AS startedAt, s.ended_at AS endedAt,
                  COUNT(sp.id) AS players
             FROM sessions s
             LEFT JOIN session_players sp ON sp.session_id = s.id
            WHERE s.mode = 'classic' AND (s.quiz_id = ? OR s.quiz_id = ?)
            GROUP BY s.id
            ORDER BY s.started_at DESC`
        ).all(quizId, idSemJson);

        if (sessaoPedida) {
          const linhas = db.prepare(
            `SELECT p.client_id AS clientId, p.real_name AS realName, p.username AS username,
                    p.avatar_3d_id AS avatar3dId, sp.points AS points, sp.rank AS rank,
                    sp.answers_json AS answersJson
               FROM session_players sp
               JOIN players p ON p.id = sp.player_id
              WHERE sp.session_id = ?
              ORDER BY sp.rank ASC`
          ).all(sessaoPedida) as any[];

          rawData.lastSessionStats = linhas.map((l) => {
            let answers: any[] = [];
            try { answers = JSON.parse(l.answersJson || '[]'); } catch { answers = []; }
            return {
              clientId: l.clientId,
              username: l.username,
              realName: nameCorrections[l.clientId || l.realName || ''] || l.realName,
              avatarUrl: l.avatar3dId ? `/api/avatar3d/r3/icons/${l.avatar3dId}` : null,
              points: l.points,
              answers,
              connected: false,
            };
          });
          rawData.selectedSession = sessaoPedida;
        }
        db.close();
      }
    } catch (e) {
      // O historico e um extra: se o banco nao abrir, o relatorio da ultima
      // sessao (que vem do arquivo) tem de continuar funcionando.
      rawData.sessionsError = String((e as any)?.message || e).slice(0, 120);
    }

    return NextResponse.json(rawData);
  } catch (error: any) {
    return NextResponse.json({ error: 'Server error: ' + error.message }, { status: 500 });
  }
}
