const jwt = require('jsonwebtoken');

module.exports = function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || req.headers.Authorization;
    if (!h || !h.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Token manquant' });
    }
    const token = h.split(' ')[1];
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // on attache l’utilisateur à la requête (id, role, etc. viennent du login)
    req.user = {
      id: payload.id,
      role: (payload.role || '').toUpperCase(),
      email: payload.email,
      name: payload.name,
      partner_id: payload.partner_id,
    };
    return next();
  } catch (e) {
    console.error('Auth error:', e.message);
    return res.status(401).json({ message: 'Token invalide ou expiré' });
  }
};
