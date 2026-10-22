// Serverfunctie voor de check-in van De Rucphense Weide.
//
// Alle geheimen staan als omgevingsvariabelen in Netlify (Site configuration →
// Environment variables), NOOIT in deze code of in de pagina:
//   JSONBIN_BIN_ID      het nummer van de bin met plekken en reserveringen
//   JSONBIN_ACCESS_KEY  een JSONBin Access Key met rechten Read + Update op bins
//                       (of JSONBIN_MASTER_KEY, als je toch een master key gebruikt)
//   ADMIN_PIN           de pincode voor de beheerpagina (minimaal 6 cijfers)
//   NTFY_TOPIC          de geheime topicnaam voor meldingen in de ntfy-app
//
// Wat de pagina hier kan vragen:
//   GET                     → alleen de plekken die gasten mogen zien (geen namen)
//   POST lookup             → zoekt één reservering op achternaam
//   POST checkin            → gast checkt in op een vrije plek
//   POST admin-load         → alles ophalen voor de beheerpagina   (pincode nodig)
//   POST admin-save         → ochtendronde / reserveringen opslaan (pincode nodig)

const MAX_PLEKKEN = 60;
const CHECKIN_BEWAARDAGEN = 30; // AVG: gastgegevens niet langer bewaren dan nodig

// ---------- limieten (tegen botjes en het raden van de pincode) ----------
// Per IP-adres, per minuut. Dit leeft in het geheugen van de functie: niet
// waterdicht (Netlify kan meerdere kopieën draaien), maar het maakt raden en
// bestoken flink lastiger.
const LIMIETEN = { pinFout: 5, lookup: 15, checkin: 5, lezen: 120 };
const tellers = new Map();

function teVaak(ip, soort) {
  const nu = Date.now();
  const sleutel = soort + '|' + ip;
  const lijst = (tellers.get(sleutel) || []).filter(t => nu - t < 60000);
  tellers.set(sleutel, lijst);
  if (tellers.size > 5000) tellers.clear(); // geheugen niet laten vollopen
  return lijst.length >= LIMIETEN[soort];
}
function tel(ip, soort) {
  const sleutel = soort + '|' + ip;
  const lijst = tellers.get(sleutel) || [];
  lijst.push(Date.now());
  tellers.set(sleutel, lijst);
}

// ---------- hulpjes ----------
const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'Pragma': 'no-cache'
};
function antwoord(status, data) {
  return { statusCode: status, headers: HEADERS, body: JSON.stringify(data) };
}

// Vandaag als JJJJ-MM-DD in Nederlandse tijd (de server draait in UTC).
function vandaag() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date());
}

function isDatum(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function tekst(s, max) {
  return String(s == null ? '' : s).trim().slice(0, max);
}

function normaliseer(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Pincode vergelijken zonder dat de rekentijd verraadt hoeveel cijfers goed zijn.
function pinKlopt(gegeven) {
  const echt = String(process.env.ADMIN_PIN || '');
  const g = String(gegeven || '');
  if (!echt) return false;
  let verschil = echt.length ^ g.length;
  for (let i = 0; i < echt.length; i++) {
    verschil |= echt.charCodeAt(i) ^ (g.charCodeAt(i) || 0);
  }
  return verschil === 0;
}

// Een reservering blokkeert de plek tot de vertrekdag; op de vertrekdag zelf
// is de plek weer vrij.
function actieveReservering(state, nummer, dag) {
  return state.reservations.find(r => r.number === nummer && (!r.until || r.until > dag)) || null;
}

function zichtbaarVoorGasten(state, nummer, dag) {
  const s = state.spots[String(nummer)];
  return !!(s && s.free && s.until && !actieveReservering(state, nummer, dag));
}

// ---------- JSONBin ----------
function jsonbinHeaders() {
  if (process.env.JSONBIN_ACCESS_KEY) return { 'X-Access-Key': process.env.JSONBIN_ACCESS_KEY };
  return { 'X-Master-Key': process.env.JSONBIN_MASTER_KEY };
}

function ontbrekendeInstelling() {
  if (!process.env.JSONBIN_BIN_ID) return 'JSONBIN_BIN_ID';
  if (!process.env.JSONBIN_ACCESS_KEY && !process.env.JSONBIN_MASTER_KEY) return 'JSONBIN_ACCESS_KEY';
  if (!process.env.ADMIN_PIN) return 'ADMIN_PIN';
  return null;
}

async function leesState() {
  const url = 'https://api.jsonbin.io/v3/b/' + process.env.JSONBIN_BIN_ID + '/latest';
  const res = await fetch(url, { headers: { ...jsonbinHeaders(), 'X-Bin-Meta': 'false' } });
  if (!res.ok) throw new Error('JSONBin lezen mislukt (status ' + res.status + ')');
  const state = await res.json();
  // Een lege of kapotte reactie NOOIT als "alles leeg" behandelen, anders kan
  // een volgende opslag alle plekken en reserveringen wissen.
  if (!state || typeof state !== 'object') throw new Error('JSONBin gaf geen geldige data');
  if (!state.spots || typeof state.spots !== 'object') state.spots = {};
  if (!Array.isArray(state.reservations)) state.reservations = [];
  if (!Array.isArray(state.checkins)) state.checkins = [];
  return state;
}

async function schrijfState(state) {
  // Oude gastgegevens automatisch opruimen bij elke opslag.
  const grens = Date.now() - CHECKIN_BEWAARDAGEN * 24 * 3600 * 1000;
  state.checkins = state.checkins.filter(c => !c.tijd || new Date(c.tijd).getTime() > grens);
  const url = 'https://api.jsonbin.io/v3/b/' + process.env.JSONBIN_BIN_ID;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...jsonbinHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(state)
  });
  if (!res.ok) throw new Error('JSONBin opslaan mislukt (status ' + res.status + ')');
}

// ---------- melding naar de ntfy-app ----------
// De melding bevat de gegevens van de gast. Dat kan alleen veilig omdat de
// topicnaam geheim is: hij staat alleen in Netlify (NTFY_TOPIC), niet in de
// pagina of op GitHub. Deel die naam dus met niemand anders dan Manon en Johnno.
// Tikken op de melding opent direct de beheerpagina.
async function stuurMelding(titel, bericht) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return; // geen topic ingesteld: check-in werkt gewoon, alleen geen melding
  try {
    await fetch('https://ntfy.sh/' + encodeURIComponent(topic), {
      method: 'POST',
      body: bericht,
      headers: { 'Title': titel, 'Tags': 'camper', 'Click': 'https://cprucphen.netlify.app/#beheer' }
    });
  } catch (e) { /* melding mislukt, check-in blijft geslaagd */ }
}

function publiekeState(state) {
  const dag = vandaag();
  const spots = {};
  for (let n = 1; n <= MAX_PLEKKEN; n++) {
    if (zichtbaarVoorGasten(state, n, dag)) {
      spots[String(n)] = { free: true, until: state.spots[String(n)].until };
    }
  }
  return { spots, reservations: [] };
}

function beheerState(state) {
  return { spots: state.spots, reservations: state.reservations, checkins: state.checkins };
}

// ---------- de functie zelf ----------
exports.handler = async function (event) {
  const ip = (event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || '')).split(',')[0].trim() || 'onbekend';

  const mist = ontbrekendeInstelling();
  if (mist) {
    return antwoord(500, { error: 'instelling', melding: 'De instelling ' + mist + ' ontbreekt in Netlify (Environment variables).' });
  }

  try {
    if (event.httpMethod === 'GET') {
      if (teVaak(ip, 'lezen')) return antwoord(429, { error: 'te-vaak' });
      tel(ip, 'lezen');
      return antwoord(200, publiekeState(await leesState()));
    }

    if (event.httpMethod !== 'POST') return antwoord(405, { error: 'niet-toegestaan' });

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch (e) { return antwoord(400, { error: 'ongeldig' }); }
    const actie = body.action;

    // ----- gast: reservering opzoeken -----
    if (actie === 'lookup') {
      if (teVaak(ip, 'lookup')) return antwoord(429, { error: 'te-vaak' });
      tel(ip, 'lookup');
      const naam = normaliseer(tekst(body.naam, 80));
      if (!naam) return antwoord(400, { error: 'ongeldig' });
      const state = await leesState();
      const dag = vandaag();
      const match = state.reservations.find(r => normaliseer(r.achternaam) === naam && (!r.until || r.until >= dag));
      if (!match) return antwoord(200, { found: false });
      await stuurMelding('Reservering ingecheckt',
        'Reservering ingecheckt — plek ' + match.number + '\n' + match.achternaam + '\nGereserveerd tot: ' + match.until);
      return antwoord(200, { found: true, number: match.number, until: match.until });
    }

    // ----- gast: inchecken op een vrije plek -----
    if (actie === 'checkin') {
      if (teVaak(ip, 'checkin')) return antwoord(429, { error: 'te-vaak' });
      tel(ip, 'checkin');
      const plek = parseInt(body.spot, 10);
      const gast = {
        naam: tekst(body.name, 100),
        email: tekst(body.email, 120),
        telefoon: tekst(body.telefoon, 40),
        kenteken: tekst(body.kenteken, 20),
        personen: tekst(body.personen, 3),
        vertrek: body.vertrek === 'onbekend' ? 'onbekend' : (isDatum(body.vertrek) ? body.vertrek : '')
      };
      if (!(plek >= 1 && plek <= MAX_PLEKKEN) || !gast.naam || !gast.email || !gast.telefoon || !gast.kenteken || !gast.vertrek) {
        return antwoord(400, { error: 'ongeldig' });
      }
      const state = await leesState();
      if (!zichtbaarVoorGasten(state, plek, vandaag())) {
        return antwoord(409, { error: 'plek-bezet' }); // net door iemand anders genomen
      }
      state.spots[String(plek)] = { free: false, until: null };
      state.checkins.push({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        tijd: new Date().toISOString(),
        plek,
        ...gast
      });
      await schrijfState(state);
      await stuurMelding('Nieuwe gast ingecheckt',
        'Nieuwe check-in — plek ' + plek + '\n' +
        gast.naam + ' · ' + gast.telefoon + ' · ' + gast.email + ' · ' + gast.kenteken + ' · ' + (gast.personen || '?') + ' pers.\n' +
        'Vertrek: ' + (gast.vertrek === 'onbekend' ? 'nog niet bekend' : gast.vertrek));
      return antwoord(200, { ok: true });
    }

    // ----- beheer: alles hieronder vraagt de pincode -----
    if (actie === 'admin-load' || actie === 'admin-save') {
      if (teVaak(ip, 'pinFout')) return antwoord(429, { error: 'te-vaak' });
      if (!pinKlopt(body.pin)) {
        tel(ip, 'pinFout');
        return antwoord(401, { error: 'pin' });
      }

      const state = await leesState();
      if (actie === 'admin-load') return antwoord(200, beheerState(state));

      // Ochtendronde: alle 60 plekken in één keer.
      if (body.spots && typeof body.spots === 'object') {
        const nieuw = {};
        for (let n = 1; n <= MAX_PLEKKEN; n++) {
          const s = body.spots[String(n)] || {};
          const vrij = !!s.free;
          nieuw[String(n)] = { free: vrij, until: vrij && isDatum(s.until) ? s.until : null };
        }
        state.spots = nieuw;
      }
      // Reserveringen toevoegen.
      if (Array.isArray(body.addReservations)) {
        body.addReservations.slice(0, 100).forEach(r => {
          const nummer = parseInt(r.number, 10);
          const naam = tekst(r.achternaam, 80);
          if (naam && nummer >= 1 && nummer <= MAX_PLEKKEN && isDatum(r.until)) {
            state.reservations.push({
              id: tekst(r.id, 40) || Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
              achternaam: naam, number: nummer, until: r.until
            });
          }
        });
      }
      // Reservering of check-in verwijderen.
      if (body.removeReservationId) {
        state.reservations = state.reservations.filter(r => r.id !== body.removeReservationId);
      }
      if (body.removeCheckinId) {
        state.checkins = state.checkins.filter(c => c.id !== body.removeCheckinId);
      }
      await schrijfState(state);
      return antwoord(200, beheerState(state));
    }

    return antwoord(400, { error: 'onbekende-actie' });
  } catch (e) {
    // Geen technische details naar buiten; wel in het Netlify-logboek.
    console.error(e.message);
    return antwoord(502, { error: 'server' });
  }
};
