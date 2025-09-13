// src/services/kpiService.js
const { QueryTypes } = require('sequelize');
const db = require('../models');

const sequelize = db.sequelize;

/**
 * KPIs à partir de la table RAW public.fiche_suivi_2025_raw (c1..c147)
 * Mapping RAW utilisé :
 *  - demande_id      = concat_ws('-', c3, c4)   (Code Projet + sous-code)
 *  - d_ech           = c10   (date réception échantillons) — MM/DD/YY(YY)
 *  - d_fact          = c22   (date facturation) — MM/DD/YY(YY)
 *  - d_rap           = c26   (date rapport)     — MM/DD/YY(YY)
 *  - delai_exec_j    = c23   (jours)  => Durée moyenne d'exécution d’essai
 *  - delai_trait_j   = c24   (jours)  => Durée moyenne de traitement de dossier
 *  - statut_delai    = c25   ("Dans les délais" / "Hors délais")
 *
 *  - client          = c5
 *  - marque_modele   = c6 + " " + c7 (si présents)
 *  - kg              = c8  (numérique ; virgule/texte toléré)
 *  - type_essai      = c9
 *
 * NB: Les dates ne sont parsées que si elles matchent un motif MM/DD/YY(YY)
 */
async function dashboardFromDb(year = 2025, delaiRapportJ = 30) {
  const BASE_SQL = `
  WITH params AS (
    SELECT
      make_date(:year,1,1)::date                       AS d0,
      (make_date(:year,1,1) + interval '1 year')::date AS d1,
      :delaiRapportJ::int                              AS delai_j
  ),

  /* ========= Normalisation RAW sécurisée ========= */
  base AS (
    SELECT
      /* Identifiant de demande (ex: A373-A373251) */
      concat_ws('-', NULLIF(c3,''), NULLIF(c4,'')) AS demande_id,

      /* 1 ligne = 1 échantillon */
      1::int AS nb_ech,

      /* d_ech : MM/DD/YY ou MM/DD/YYYY => sinon NULL */
      CASE
        WHEN c10 ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{2}$'  THEN to_date(c10, 'FMMM/FMDD/YY')
        WHEN c10 ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$'  THEN to_date(c10, 'FMMM/FMDD/YYYY')
        ELSE NULL
      END AS d_ech,

      /* d_fact */
      CASE
        WHEN c22 ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{2}$'  THEN to_date(c22, 'FMMM/FMDD/YY')
        WHEN c22 ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$'  THEN to_date(c22, 'FMMM/FMDD/YYYY')
        ELSE NULL
      END AS d_fact,

      /* d_rap */
      CASE
        WHEN c26 ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{2}$'  THEN to_date(c26, 'FMMM/FMDD/YY')
        WHEN c26 ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$'  THEN to_date(c26, 'FMMM/FMDD/YYYY')
        ELSE NULL
      END AS d_rap,

      /* Délais numériques (on enlève tout sauf chiffres) */
      NULLIF(regexp_replace(COALESCE(c23,''),'[^0-9]','','g'),'')::int AS delai_exec_j,
      NULLIF(regexp_replace(COALESCE(c24,''),'[^0-9]','','g'),'')::int AS delai_trait_j,
      NULLIF(c25,'') AS statut_delai,

      /* Champs planning */
      NULLIF(c5,'')                                                    AS client,
      NULLIF(trim(both ' ' from concat_ws(' ', NULLIF(c6,''), NULLIF(c7,''))), '') AS marque_modele,
      NULLIF(
        regexp_replace(
          regexp_replace(COALESCE(c8,''), '[^0-9,.-]', '', 'g'),
          ',', '.', 'g'
        ),
        ''
      )::numeric                                                        AS kg,
      NULLIF(c9,'')                                                     AS type_essai
    FROM public.fiche_suivi_2025_raw
  ),

  /* ========= Agrégats année ========= */
  totaux AS (
    SELECT
      (SELECT COUNT(DISTINCT b.demande_id) FROM base b, params p
        WHERE b.d_ech >= p.d0 AND b.d_ech < p.d1) AS demandes_total,
      (SELECT COUNT(*) FROM base b, params p
        WHERE b.d_ech >= p.d0 AND b.d_ech < p.d1) AS echantillons_total
  ),

  acheves AS (
    SELECT
      (SELECT COUNT(DISTINCT b.demande_id) FROM base b, params p
        WHERE b.d_rap IS NOT NULL AND b.d_rap >= p.d0 AND b.d_rap < p.d1) AS demandes,
      (SELECT COUNT(*) FROM base b, params p
        WHERE b.d_rap IS NOT NULL AND b.d_rap >= p.d0 AND b.d_rap < p.d1) AS echantillons
  ),

  /* "En cours" = reçus (d_ech) dans l'année et sans rapport */
  encours AS (
    SELECT
      (SELECT COUNT(DISTINCT b.demande_id) FROM base b, params p
        WHERE b.d_ech IS NOT NULL AND b.d_ech >= p.d0 AND b.d_ech < p.d1 AND b.d_rap IS NULL) AS demandes,
      (SELECT COUNT(*) FROM base b, params p
        WHERE b.d_ech IS NOT NULL AND b.d_ech >= p.d0 AND b.d_ech < p.d1 AND b.d_rap IS NULL) AS echantillons
  ),

  /* Attente de confirmation (proxy): reçus, sans rapport, sans facture */
  attente_conf AS (
    SELECT
      (SELECT COUNT(DISTINCT b.demande_id) FROM base b, params p
        WHERE b.d_ech >= p.d0 AND b.d_ech < p.d1 AND b.d_rap IS NULL AND b.d_fact IS NULL) AS n
  ),

  /* Durées moyennes via c23/c24, sur les dossiers aboutis de l'année */
  durees AS (
    SELECT
      ROUND(AVG(b.delai_exec_j)::numeric, 0)  AS realisation_j,
      ROUND(AVG(b.delai_trait_j)::numeric, 0) AS traitement_j
    FROM base b, params p
    WHERE b.d_rap IS NOT NULL
      AND b.d_rap >= p.d0 AND b.d_rap < p.d1
      AND (b.delai_exec_j IS NOT NULL OR b.delai_trait_j IS NOT NULL)
  ),

  /* Respect des délais : delai_exec_j <= seuil */
  respect AS (
    SELECT COALESCE(
      ROUND(
        100.0 * SUM((b.delai_exec_j IS NOT NULL AND b.delai_exec_j <= p.delai_j)::int)
        / NULLIF(SUM((b.delai_exec_j IS NOT NULL)::int), 0)
      , 0), 0) AS pct
    FROM base b, params p
    WHERE b.d_rap IS NOT NULL
      AND b.d_rap >= p.d0 AND b.d_rap < p.d1
  ),

  /* Réception / En attente d’essai (état actuel) */
  reception AS (
    SELECT COUNT(*) AS appareils,
           COALESCE(SUM(nb_ech),0) AS ech,
           COALESCE(SUM(nb_ech),0) * 0.64 AS m2
    FROM base b
    WHERE b.d_ech IS NOT NULL
      AND b.d_rap IS NULL
  ),

  /* Calendrier jours ouvrés (lun → ven) */
  cal_jours AS (
    SELECT d::date AS d
    FROM params p,
         generate_series((SELECT d0 FROM params),
                         (SELECT d1 FROM params) - interval '1 day',
                         interval '1 day') d
    WHERE EXTRACT(ISODOW FROM d) BETWEEN 1 AND 5
  ),
  jours_travail AS (SELECT COUNT(*)::int AS n FROM cal_jours),

  /* Jours d'utilisation (de d_ech jusqu'au d_rap ou "today") */
  util_jours AS (
    SELECT COUNT(DISTINCT dd.d)::int AS n
    FROM (
      SELECT daterange(
               GREATEST(b.d_ech, (SELECT d0 FROM params)),
               LEAST(COALESCE(b.d_rap, CURRENT_DATE) + 1, (SELECT d1 FROM params)),
               '[]'
             ) AS r
      FROM base b
      WHERE b.d_ech IS NOT NULL
        AND GREATEST(b.d_ech, (SELECT d0 FROM params))
            < LEAST(COALESCE(b.d_rap, CURRENT_DATE) + 1, (SELECT d1 FROM params))
    ) x
    JOIN LATERAL (
      SELECT d::date
      FROM params p,
           generate_series((SELECT d0 FROM params),
                           (SELECT d1 FROM params) - interval '1 day',
                           interval '1 day') d
    ) dd ON dd.d <@ x.r
  ),

  /* ===== Planification “2 semaines” =====
     Choix: on affiche les demandes SANS RAPPORT, reçues
     dans les 14 DERNIERS jours (à traiter/planifier). */
  planning_raw AS (
    SELECT
      b.client,
      b.marque_modele,
      b.kg,
      b.type_essai,
      b.d_ech AS d_reception
    FROM base b
    WHERE b.d_rap IS NULL
      AND b.d_ech IS NOT NULL
      AND b.d_ech >= CURRENT_DATE - interval '14 days'
  ),
  planning AS (
    SELECT COALESCE(json_agg(
      json_build_object(
        'client',        pr.client,
        'marqueModele',  pr.marque_modele,
        'kg',            pr.kg,
        'typeEssai',     pr.type_essai,
        'date',          to_char(pr.d_reception,'YYYY-MM-DD')
      )
      ORDER BY pr.d_reception DESC
    ), '[]'::json) AS items
    FROM planning_raw pr
  )
  `;

  /* Agrégat annuel à partir de la table mensuelle (si elle existe) */
  const sqlWithMonthlyPerf = `
  ${BASE_SQL},
  mens AS (
    SELECT
      SUM(jours_travail)             AS jtrav,
      SUM(arret_programme_jours)     AS arret_prog,
      SUM(arret_non_programme_jours) AS arret_nonprog,
      SUM(utilisation_jours)         AS jutil,
      SUM(nb_pannes)                 AS nb_pannes
    FROM public.lab_perf_mensuelle m
    WHERE m.annee = :year
  ),
  taux AS (
    SELECT
      COALESCE(ROUND(100.0 * ((SELECT jtrav FROM mens) - ((SELECT arret_prog FROM mens)+(SELECT arret_nonprog FROM mens)))
        / NULLIF((SELECT jtrav FROM mens),0), 0), 0) AS dispo_pct,
      COALESCE(ROUND(100.0 * ((SELECT jtrav FROM mens) - (SELECT jutil FROM mens))
        / NULLIF((SELECT jtrav FROM mens),0), 0), 0) AS occupation_pct
  ),
  arrets AS (
    SELECT
      COALESCE((SELECT arret_prog    FROM mens), 0)::int AS jours_planned,
      COALESCE((SELECT arret_nonprog FROM mens), 0)::int AS jours_unplanned,
      COALESCE((SELECT nb_pannes     FROM mens), 0)::int AS nb_pannes,
      CASE WHEN (SELECT nb_pannes FROM mens) > 0
           THEN ROUND((SELECT arret_nonprog FROM mens)::numeric/(SELECT nb_pannes FROM mens),0)
           ELSE NULL END AS mttr_j,
      CASE WHEN (SELECT nb_pannes FROM mens) > 0
           THEN ROUND(((SELECT jtrav FROM mens)-(SELECT arret_nonprog FROM mens))::numeric/(SELECT nb_pannes FROM mens),0)
           ELSE NULL END AS mtbf_jours
  )
  SELECT
    (SELECT demandes_total     FROM totaux)  AS demandes_total,
    (SELECT echantillons_total FROM totaux)  AS echantillons_total,
    (SELECT demandes           FROM acheves) AS acheves_demandes,
    (SELECT echantillons       FROM acheves) AS acheves_echantillons,
    (SELECT demandes           FROM encours) AS encours_demandes,
    (SELECT echantillons       FROM encours) AS encours_echantillons,
    (SELECT n                  FROM attente_conf) AS attente_confirmation,
    COALESCE((SELECT realisation_j FROM durees),0) AS duree_moy_realisation_j,
    COALESCE((SELECT traitement_j  FROM durees),0) AS duree_moy_traitement_j,
    COALESCE((SELECT pct           FROM respect),0) AS respect_delais_pct,
    COALESCE((SELECT appareils     FROM reception),0) AS reception_appareils,
    COALESCE((SELECT m2            FROM reception),0) AS reception_m2,
    0 AS stockage_appareils,
    0.0::numeric AS stockage_m2,
    COALESCE((SELECT dispo_pct     FROM taux),0)  AS taux_dispo_pct,
    COALESCE((SELECT occupation_pct FROM taux),0) AS taux_occupation_pct,
    COALESCE((SELECT nb_pannes       FROM arrets),0) AS nb_pannes,
    (SELECT mttr_j                     FROM arrets)  AS mttr_j,
    COALESCE((SELECT jours_planned     FROM arrets),0) AS arret_programme_jours,
    COALESCE((SELECT jours_unplanned   FROM arrets),0) AS arret_non_programme_jours,
    (SELECT mtbf_jours                 FROM arrets)  AS mtbf_jours,
    (SELECT items FROM planning) AS planning
  ;
  `;

  /* Fallback : sans table lab_perf_mensuelle */
  const sqlFallback = `
  ${BASE_SQL},
  taux AS (
    SELECT
      0::numeric AS dispo_pct,
      ROUND(
        100.0 * ((SELECT n FROM jours_travail) - COALESCE((SELECT n FROM util_jours),0))
        / NULLIF((SELECT n FROM jours_travail),0)
      , 0) AS occupation_pct
  )
  SELECT
    (SELECT demandes_total     FROM totaux)  AS demandes_total,
    (SELECT echantillons_total FROM totaux)  AS echantillons_total,
    (SELECT demandes           FROM acheves) AS acheves_demandes,
    (SELECT echantillons       FROM acheves) AS acheves_echantillons,
    (SELECT demandes           FROM encours) AS encours_demandes,
    (SELECT echantillons       FROM encours) AS encours_echantillons,
    (SELECT n                  FROM attente_conf) AS attente_confirmation,
    COALESCE((SELECT realisation_j FROM durees),0) AS duree_moy_realisation_j,
    COALESCE((SELECT traitement_j  FROM durees),0) AS duree_moy_traitement_j,
    COALESCE((SELECT pct           FROM respect),0) AS respect_delais_pct,
    COALESCE((SELECT appareils     FROM reception),0) AS reception_appareils,
    COALESCE((SELECT m2            FROM reception),0) AS reception_m2,
    0 AS stockage_appareils, 0.0::numeric AS stockage_m2,
    COALESCE((SELECT dispo_pct     FROM taux),0)  AS taux_dispo_pct,
    COALESCE((SELECT occupation_pct FROM taux),0) AS taux_occupation_pct,
    0   AS nb_pannes,
    NULL::numeric AS mttr_j,
    0   AS arret_programme_jours,
    0   AS arret_non_programme_jours,
    NULL::numeric AS mtbf_jours,
    (SELECT items FROM planning) AS planning
  ;
  `;

  try {
    const [row] = await sequelize.query(sqlWithMonthlyPerf, {
      type: QueryTypes.SELECT,
      replacements: { year, delaiRapportJ },
    });
    return mapRowToPayload(row);
  } catch {
    const [row] = await sequelize.query(sqlFallback, {
      type: QueryTypes.SELECT,
      replacements: { year, delaiRapportJ },
    });
    return mapRowToPayload(row);
  }
}

function mapRowToPayload(r) {
  const toNum  = (v) => (v == null ? 0 : Number(v));
  const to1dec = (v) => (v == null ? 0 : Number(Number(v).toFixed(1)));

  const planning = Array.isArray(r.planning)
    ? r.planning
    : (r.planning ? JSON.parse(r.planning) : []);

  return {
    nombreTotal: {
      demandes:     toNum(r.demandes_total),
      echantillons: toNum(r.echantillons_total),
    },
    acheves: {
      demandes:     toNum(r.acheves_demandes),
      echantillons: toNum(r.acheves_echantillons),
    },
    enCours: {
      demandes:     toNum(r.encours_demandes),
      echantillons: toNum(r.encours_echantillons),
    },

    attenteConfirmation: toNum(r.attente_confirmation),

    dureeMoyRealisationJ: toNum(r.duree_moy_realisation_j),
    dureeMoyTraitementJ:  toNum(r.duree_moy_traitement_j),

    respectDelaisPct: toNum(r.respect_delais_pct),

    reception: {
      appareils:      toNum(r.reception_appareils),
      espaceOccupeM2: to1dec(r.reception_m2),
    },
    stockageRetour: {
      appareils:      toNum(r.stockage_appareils),
      espaceOccupeM2: to1dec(r.stockage_m2),
    },

    tauxDisponibilitePct: toNum(r.taux_dispo_pct),
    tauxOccupationPct:    toNum(r.taux_occupation_pct),

    nbPannes:              toNum(r.nb_pannes),
    mtbfJours:             r.mtbf_jours == null ? null : Number(r.mtbf_jours),
    mttrJours:             r.mttr_j     == null ? null : Number(r.mttr_j),
    arretProgrammeJours:   toNum(r.arret_programme_jours),
    arretNonProgrammeJours:toNum(r.arret_non_programme_jours),

    achevesAggregat:  toNum(r.acheves_demandes),
    enCoursAggregat:  toNum(r.encours_demandes),

    /* NEW: Planning 2 semaines (tableau d’objets) */
    planning,
  };
}

module.exports = { dashboardFromDb };
