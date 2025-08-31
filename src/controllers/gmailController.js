// services/gmailImapService.js
const imaps = require('imap-simple');
const { google } = require('googleapis');

async function getAccessTokenFromRefresh({
  clientId,
  clientSecret,
  redirectUri,
  refreshToken,
}) {
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  const { token } = await oauth2Client.getAccessToken(); // auto refresh
  if (!token) throw new Error('No access token returned');
  return token; // string
}

function buildXOAuth2Token(userEmail, accessToken) {
  const authString = `user=${userEmail}\x01auth=Bearer ${accessToken}\x01\x01`;
  return Buffer.from(authString, 'utf8').toString('base64');
}

exports.getUnreadCount = async (req, res) => {
  try {
    const {
      GMAIL_USER,
      GMAIL_CLIENT_ID,
      GMAIL_CLIENT_SECRET,
      GMAIL_REDIRECT_URI,
      GMAIL_REFRESH_TOKEN, // ⚠️ mets ICI le **NOUVEAU** RT
    } = process.env;

    // Log de contrôle (suffixe seulement)
    console.log('RT suffix:', '****' + String(GMAIL_REFRESH_TOKEN).slice(-6));

    // 1) access_token frais via googleapis
    const accessToken = await getAccessTokenFromRefresh({
      clientId: GMAIL_CLIENT_ID,
      clientSecret: GMAIL_CLIENT_SECRET,
      redirectUri: GMAIL_REDIRECT_URI,
      refreshToken: GMAIL_REFRESH_TOKEN,
    });

    // 2) Transformer en token XOAUTH2 (SASL) pour IMAP
    const xoauth2Token = buildXOAuth2Token(GMAIL_USER, accessToken);

    // 3) Connexion IMAP avec imap-simple
    const config = {
      imap: {
        user: GMAIL_USER,
        xoauth2: xoauth2Token,   // <= on passe la chaîne XOAUTH2, pas un mot de passe
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        authTimeout: 10000,
        tlsOptions: { servername: 'imap.gmail.com' },
      },
    };

    const connection = await imaps.connect(config);
    await connection.openBox('INBOX');

    const searchCriteria = ['UNSEEN'];
    const fetchOptions = { bodies: ['HEADER'], markSeen: false };
    const messages = await connection.search(searchCriteria, fetchOptions);

    await connection.end();
    return res.status(200).json({ unreadCount: messages.length });
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes('invalid_grant')) {
      return res.status(409).json({ error: 'RECONNECT_GMAIL' });
    }
    console.error('❌ IMAP error:', err);
    return res.status(500).json({ error: 'IMAP_ERROR' });
  }
};
