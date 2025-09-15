const nodemailer = require("nodemailer");
require("dotenv").config();
const { google } = require("googleapis");

// === CONFIGURATION ADMIN === (mot de passe d'application)
const transporterAdmin = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,               // ex: cetimea0@gmail.com
    pass: process.env.EMAIL_PASS_NODEMAILER,    // mot de passe d’application
  },
});

// === CONFIGURATION CLIENT === (OAuth2)
const {
  GMAIL_USER,
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  GMAIL_REFRESH_TOKEN,
  GMAIL_REDIRECT_URI,
} = process.env;

const oAuth2Client = new google.auth.OAuth2(
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  GMAIL_REDIRECT_URI
);
oAuth2Client.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });

/**
 * ✅ Envoi d’un email à l’administrateur CETIME (nouvelle demande de RDV)
 */
// utils/emailSender.js (remplace UNIQUEMENT la fonction sendEmailToAdmin)

const sendEmailToAdmin = async (rdvOrPayload, clientNomArg = "Client") => {
  // --- 1) Normalisation des paramètres (2 signatures supportées) ---
  let rdv, clientNom, subject, html;

  if (
    rdvOrPayload &&
    (Object.prototype.hasOwnProperty.call(rdvOrPayload, "dateRdv") ||
     Object.prototype.hasOwnProperty.call(rdvOrPayload, "duree")   ||
     Object.prototype.hasOwnProperty.call(rdvOrPayload, "statut")) &&
    !rdvOrPayload.rdv // cas: sendEmailToAdmin(rdv, clientNom)
  ) {
    rdv = rdvOrPayload;
    clientNom = clientNomArg;
  } else {
    // cas: sendEmailToAdmin({ rdv, clientName, subject, html }) OU
    //      sendEmailToAdmin({ dateRdv, duree, statut, clientName, subject, html })
    const p = rdvOrPayload || {};
    rdv = p.rdv || { dateRdv: p.dateRdv, duree: p.duree, statut: p.statut };
    clientNom = p.clientName || clientNomArg;
    subject = p.subject;
    html = p.html;
  }

  // --- 2) Sécurisation des champs ---
  const toDate = (v) => {
    try {
      const d = new Date(v);
      return isNaN(d.getTime()) ? null : d;
    } catch {
      return null;
    }
  };

  const d = toDate(rdv?.dateRdv);
  const dateStr = d
    ? d.toLocaleString("fr-FR", { hour12: false })
    : "—";

  const dureeNum = rdv?.duree != null && !Number.isNaN(Number(rdv.duree))
    ? Number(rdv.duree)
    : null;

  const statutStr = rdv?.statut ?? "—";

  const safeClient = clientNom || "Client";

  const finalSubject = subject || "📅 Nouvelle demande de rendez-vous";

  const fallbackHtml = `
    <div style="font-family: 'Segoe UI', sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
      <h2 style="color: #3b82f6; text-align: center;">📅 Nouvelle demande de rendez-vous</h2>
      <p style="font-size: 16px; margin-bottom: 20px;">
        Une nouvelle demande de rendez-vous a été soumise par <strong>${safeClient}</strong> :
      </p>
      <table style="width: 100%; font-size: 15px; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px; font-weight: bold;">Nom du client :</td>
          <td style="padding: 8px;">${safeClient}</td>
        </tr>
        <tr style="background-color: #f9f9f9;">
          <td style="padding: 8px; font-weight: bold;">Date RDV :</td>
          <td style="padding: 8px;">${dateStr}</td>
        </tr>
        <tr>
          <td style="padding: 8px; font-weight: bold;">Durée :</td>
          <td style="padding: 8px;">${dureeNum != null ? `${dureeNum} minutes` : "—"}</td>
        </tr>
        <tr style="background-color: #f9f9f9;">
          <td style="padding: 8px; font-weight: bold;">Statut :</td>
          <td style="padding: 8px;">${statutStr}</td>
        </tr>
      </table>
      <p style="margin-top: 30px; font-size: 14px; color: #777; text-align: center;">
        CETIME Plateforme – Notification automatique
      </p>
    </div>
  `;

  const mailOptions = {
    from: `"CETIME Plateforme" <${process.env.EMAIL_USER}>`,
    to: process.env.ADMIN_EMAIL,
    subject: finalSubject,
    html: html || fallbackHtml, // si html custom fourni, on le respecte
  };

  try {
    const info = await transporterAdmin.sendMail(mailOptions);
    console.log("✅ Email envoyé à l'administrateur :", info.response);
  } catch (error) {
    console.error("❌ Erreur email admin :", error.message);
  }
};


/**
 * ✅ Envoi d’un email au client (confirmation de RDV)
 */
const sendEmailToClient = async ({ to, subject, html }) => {
  try {
    const accessToken = await oAuth2Client.getAccessToken();

    const transport = nodemailer.createTransport({
      service: "gmail",
      auth: {
        type: "OAuth2",
        user: GMAIL_USER,
        clientId: GMAIL_CLIENT_ID,
        clientSecret: GMAIL_CLIENT_SECRET,
        refreshToken: GMAIL_REFRESH_TOKEN,
        accessToken: accessToken.token,
      },
    });

    const mailOptions = {
      from: `"CETIME" <${GMAIL_USER}>`,
      to,
      subject,
      html,
    };

    const result = await transport.sendMail(mailOptions);
    console.log("📨 Email envoyé au client :", to);
    return result;
  } catch (error) {
    console.error("❌ Erreur email client :", error.message);
  }
};

module.exports = {
  sendEmailToAdmin,
  sendEmailToClient,
};
