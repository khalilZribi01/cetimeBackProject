/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const dayjs = require('dayjs');
const customParse = require('dayjs/plugin/customParseFormat');
dayjs.extend(customParse);

const db = require('../models');

const CSV_PATH = process.argv[2] || path.join(__dirname, '../scripts/Fiche_de_suivi_2025.csv');
const YEAR = 2025;

// helper date
function parseDate(v) {
  if (!v) return null;
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400 * 1000)); // excel float
  const s = String(v).trim();
  const fmts = ['DD/MM/YYYY', 'DD/MM/YY', 'YYYY-MM-DD', 'DD-MM-YYYY', 'MM/DD/YYYY', 'MM/DD/YY', 'YYYY/MM/DD', 'DD MMM YYYY', 'DD MMM YY', 'YYYY-MM-DDTHH:mm:ss.SSS[Z]'];
  for (const f of fmts) {
    const d = dayjs(s, f, true);
    if (d.isValid()) return d.toDate();
  }
  const d = dayjs(s);
  return d.isValid() ? d.toDate() : null;
}

function safeInt(v, def = 1) {
  if (v === null || v === undefined || v === '') return def;
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : def;
}

const N = (s) => String(s || '').toLowerCase().replace(/[’']/g, "'").trim();

function pickKey(headers, containsList) {
  const want = containsList.map(N);
  return headers.find(h => want.some(w => N(h).includes(w))) || null;
}

async function run() {
  console.log('Lecture CSV:', CSV_PATH);
  const buf = fs.readFileSync(CSV_PATH);
  const rows = parse(buf, { bom: true, skip_empty_lines: true });

  // première ligne = entêtes
  const headers = rows[0].map(h => String(h || '').trim());
  const dataRows = rows.slice(1);

  // mapping par "contains" (adaptez si vos entêtes diffèrent)
  const kRecDem   = pickKey(headers, ['date de réception de la demande', 'réception de la demande']);
  const kRecEch   = pickKey(headers, ['réception échant', 'reception echant']);
  const kDevis    = pickKey(headers, ['devis', "date d'envoi du devis", 'envoi devis']);
  const kConf     = pickKey(headers, ['date de confirmation', 'confirmation']);
  const kRapport  = pickKey(headers, ["rapport d'essai", 'date émission du rapport', 'date d’émission du rapport', 'rapport | date']);
  const kFacture  = pickKey(headers, ['date de facturation', 'facturation']);
  const kDebut    = pickKey(headers, ['début essai', 'debut essai']);
  const kEtat     = pickKey(headers, ['etat', 'état']);
  const kRetour   = pickKey(headers, ['attente de récupération', 'retour client']);
  const kSamples  = pickKey(headers, ['nb échant', 'nbre échant', 'nombre échant', 'nb echant', 'nombre echantillons']);

  console.log('Clés détectées:', { kRecDem, kRecEch, kDevis, kConf, kRapport, kFacture, kDebut, kEtat, kRetour, kSamples });

  // On réinitialise la table
  await db.sequelize.query('TRUNCATE TABLE public.fiche_suivi_2025 RESTART IDENTITY');

  const bulk = [];
  for (const r of dataRows) {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = r[i]; });

    const date_reception_demande     = parseDate(obj[kRecDem]);
    const date_reception_echantillons = parseDate(obj[kRecEch]);
    const date_devis                 = parseDate(obj[kDevis]);
    const date_confirmation          = parseDate(obj[kConf]);
    const date_rapport               = parseDate(obj[kRapport]);
    const date_facturation           = parseDate(obj[kFacture]);
    const debut_essai                = parseDate(obj[kDebut]);

    const etat          = (obj[kEtat] || null) ? String(obj[kEtat]).trim() : null;
    const retour_client = obj[kRetour] ? /oui|attente|récup|recup/i.test(String(obj[kRetour])) : false;
    const nb_echantillons = safeInt(obj[kSamples], 1);

    const year_demande = date_reception_demande ? new Date(date_reception_demande).getFullYear() : null;
    const year_echant  = date_reception_echantillons ? new Date(date_reception_echantillons).getFullYear() : null;

    // on ne garde que les lignes “utiles” (au moins 1 info)
    if (
      date_reception_demande || date_reception_echantillons || date_confirmation ||
      date_rapport || date_devis || date_facturation || debut_essai || etat
    ) {
      bulk.push({
        raw: obj,
        date_reception_demande,
        date_reception_echantillons,
        date_devis,
        date_confirmation,
        date_rapport,
        date_facturation,
        debut_essai,
        etat,
        retour_client,
        nb_echantillons,
        year_demande,
        year_echant,
      });
    }
  }

  if (!bulk.length) {
    console.log('Aucune ligne exploitable.');
    process.exit(0);
  }

  await db.FicheSuivi2025.bulkCreate(bulk, { validate: false });
  console.log(`Import terminé: ${bulk.length} lignes insérées.`);
}

run().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
