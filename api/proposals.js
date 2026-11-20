const allowedOrigins = new Set([
  'https://ungostensjo.vercel.app',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
]);
const allowedFields = new Set(['name', 'summary', 'description', 'important', 'hours', 'address', 'contact']);
const knownOffers = new Set([
  'Oppsalklubben', 'Bøler fritidsklubb', 'Klubb1 på Manglerud', 'Skullerud aktivitetshus',
  'Stikkontakten Gamingsenter', 'Abildsøklubben', 'Deichman Oppsal', 'Deichman Bøler',
  'Gaming og e-sport', 'Musikkstudio og bandøving', 'Matlaging og forming', 'Klatring, turn og DJ',
  'Warhammer og fotballkafé', 'Bokklubb og PS5', 'Svømming og skate', 'Ut på tur', 'UKM Østensjø',
  'Østensjø bydelsdager', 'LAN og gamingturneringer', 'Konserter og musikkverksteder',
  'Bibliotekarrangementer', 'Ferieaktiviteter og klubbturer', '@WORK Østensjø',
  'Jobbsøkerhjelp fra Utekontakten', 'Oppfølgingstjenesten (OT)', 'NAVs ungdomsgaranti',
  'Kommunal læreplassveiledning', 'Leksehjelp', 'Skolehelsetjenesten', 'Helsestasjon for ungdom',
  'Helsestasjon for kjønn og seksualitet', 'Fastlege og tannhelse', 'Rask psykisk helsehjelp Østensjø',
  'Forebyggende barne- og ungdomsteam', 'Utekontakten Østensjø', 'Ung Arena Oslo sentrum',
  'Rusveiledning og hasjavvenning', 'BUP Østensjø og Søndre Oslo DPS', 'Østensjø barneverntjeneste',
  'Barnevernsvakten', 'Alarmtelefonen for barn og unge', 'Overgrepsmottaket i Oslo', 'Legevakten',
  'Skole- og lærlingombudet', 'ung.no', 'BUA Østensjø', 'Bydelens utstyrsbank', 'Utstyr på klubbene',
  'Tilskudd til ungdomstiltak', 'Oslos fritidskort', 'Østensjø ungdomsråd', 'Klubbråd',
  'URÅD ved Deichman Oppsal',
]);
const MAX_BODY_BYTES = 20000;
const recentSubmissions = new Map();

function respond(res, status, payload) {
  res.status(status).json(payload);
}

function sanitizeProposal(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return { schemaVersion: 1, layout: [], edits: {}, note: '' };
  const edits = {};
  if (source.edits && typeof source.edits === 'object' && !Array.isArray(source.edits)) {
    for (const [offer, fields] of Object.entries(source.edits)) {
      if (!knownOffers.has(offer) || !fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
      const clean = {};
      for (const field of allowedFields) {
        if (typeof fields[field] === 'string') clean[field] = fields[field].slice(0, field === 'description' || field === 'important' ? 1200 : 500);
      }
      if (Object.keys(clean).length) edits[offer] = clean;
    }
  }
  const layout = Array.isArray(source.layout)
    ? [...new Set(source.layout.filter(name => typeof name === 'string' && knownOffers.has(name)))].slice(0, 100)
    : [];
  const note = typeof source.note === 'string' ? source.note.trim().slice(0, 1000) : '';
  return { schemaVersion: 1, layout, edits, note };
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin;
  if (!origin || !allowedOrigins.has(origin)) return respond(res, 403, { error: 'Ugyldig opprinnelse.' });
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return respond(res, 405, { error: 'Kun innsending støttes.' });

  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > MAX_BODY_BYTES) return respond(res, 413, { error: 'Forslaget er for stort.' });
  let payload = req.body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); }
    catch { return respond(res, 400, { error: 'Ugyldig JSON.' }); }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return respond(res, 400, { error: 'Ugyldig forslag.' });
  const proposal = sanitizeProposal(payload.proposal);
  if (typeof payload.company === 'string' && payload.company.trim()) return respond(res, 201, { received: true, proposal });

  const remoteAddress = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const clientKey = remoteAddress ? `proposal-limit:${remoteAddress}` : 'proposal-limit:unknown';
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const encodedKey = encodeURIComponent(clientKey);
    const headers = { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` };
    const countResponse = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/incr/${encodedKey}`, { headers }).catch(() => null);
    if (!countResponse?.ok) return respond(res, 503, { error: 'Forslagstjenesten er midlertidig utilgjengelig.' });
    const { result: count } = await countResponse.json();
    if (count === 1) await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/expire/${encodedKey}/3600`, { headers }).catch(() => {});
    if (count > 5) return respond(res, 429, { error: 'For mange forslag fra denne tilkoblingen. Prøv igjen senere.' });
  } else {
    const now = Date.now();
    const previous = recentSubmissions.get(clientKey);
    if (previous && now - previous < 60000) return respond(res, 429, { error: 'Vent litt før du sender et nytt forslag.' });
    recentSubmissions.set(clientKey, now);
  }

  if (!process.env.GITHUB_PROPOSAL_TOKEN) return respond(res, 503, { error: 'Forslagstjenesten er ikke konfigurert ennå.' });
  if (!Object.keys(proposal.edits).length && !proposal.layout.length && !proposal.note) {
    return respond(res, 400, { error: 'Forslaget inneholder ingen endringer.' });
  }

  const title = `Nytt forslag til UngØstensjø (${Object.keys(proposal.edits).length} tilbud)`;
  const body = [
    'Nytt endringsforslag sendt inn via UngØstensjø. Forslaget er ikke publisert.',
    '',
    proposal.note ? `Kommentar:\n${proposal.note}` : '',
    'Forslag (JSON):',
    '```json',
    JSON.stringify(proposal, null, 2),
    '```',
  ].filter(Boolean).join('\n');

  const githubResponse = await fetch('https://api.github.com/repos/walimsalim/UngOstensjo/issues', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GITHUB_PROPOSAL_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title, body }),
  });
  const result = await githubResponse.json().catch(() => ({}));
  if (!githubResponse.ok) {
    console.error('GitHub proposal submission failed:', githubResponse.status);
    return respond(res, githubResponse.status === 401 || githubResponse.status === 403 ? 503 : 502, { error: 'Forslaget kunne ikke lagres nå. Prøv igjen senere.' });
  }
  return respond(res, 201, { proposal, issueUrl: result.html_url });
};
