// controllers/auth.controller.js
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const {
  res_users,
  res_partner,
  res_groups,
  res_users_res_groups_rel,
  sequelize,
} = require('../models');

const { Op } = require('sequelize');
const { OAuth2Client } = require('google-auth-library');
const client = new OAuth2Client(
  '643716741024-b17obejeud2ksngkbj3722smrttnkk0d.apps.googleusercontent.com'
);

/* === Durée de vie des JWT (3h par défaut) === */
const ACCESS_TOKEN_TTL = process.env.JWT_EXPIRES_IN || '3h';

/* ----------------------------- Helpers rôles ----------------------------- */

const GROUP_ALIASES = {
  admin:  ['admin', 'administrator', 'administrateur'],
  agent:  ['agent', 'employee', 'employe', 'employée', 'internal user'],
  client: ['client', 'portal', 'portal user', 'public'],
};

function inferRoleFromGroups(groups) {
  const names = (groups || []).map(g => String(g.name || '').toLowerCase());
  const has = (keys) => keys.some(k => names.some(n => n.includes(k)));
  if (has(GROUP_ALIASES.admin)) return 'admin';
  if (has(GROUP_ALIASES.agent)) return 'agent';
  return 'client';
}

/* -------------------------------- Register ------------------------------- */

exports.register = async (req, res) => {
  try {
    const { name, email, login, password, role } = req.body;

    if (!name || !email || !login || !password || !role) {
      return res.status(400).json({ message: 'Champs obligatoires manquants' });
    }

    // Vérifie si le login existe déjà
    const existingUser = await res_users.findOne({ where: { login } });
    if (existingUser) {
      return res.status(409).json({ message: 'Login déjà utilisé' });
    }

    // 1) Créer le partner
    const lastPartner = await res_partner.findOne({ order: [['id', 'DESC']] });
    const nextPartnerId = (lastPartner?.id || 0) + 1;

    const newPartner = await res_partner.create({
      id: nextPartnerId,
      name,
      email,
      phone: null,
      notify_email: 'always',
      invoice_warn: 'no-message',
      sale_warn: 'no-message',
      purchase_warn: 'no-message',
      picking_warn: 'no-message',
    });

    // 2) Créer le user
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await res_users.create({
      login,
      email,
      password: hashedPassword,
      active: false,
      partner_id: newPartner.id,
      company_id: 1,
    });

    // 3) Assigner le(s) groupe(s)
    const r = String(role || '').toLowerCase();
    let where;
    if (r === 'agent' || r === 'employee') {
      where = { [Op.or]: GROUP_ALIASES.agent.map(n => ({ name: { [Op.iLike]: `%${n}%` } })) };
    } else if (r === 'admin') {
      where = { [Op.or]: GROUP_ALIASES.admin.map(n => ({ name: { [Op.iLike]: `%${n}%` } })) };
    } else {
      where = { [Op.or]: GROUP_ALIASES.client.map(n => ({ name: { [Op.iLike]: `%${n}%` } })) };
    }

    const groups = await res_groups.findAll({ where, attributes: ['id', 'name'] });
    if (!groups.length) {
      return res.status(400).json({ message: 'Groupe introuvable pour ce rôle' });
    }

    await res_users_res_groups_rel.bulkCreate(
      groups.map(g => ({ uid: newUser.id, gid: g.id })),
      { ignoreDuplicates: true }
    );

    return res.status(201).json({
      message: 'Utilisateur enregistré avec succès',
      userId: newUser.id,
      role: r,
    });
  } catch (error) {
    console.error('❌ Erreur serveur lors du register:', error);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
};

/* --------------------------------- Login -------------------------------- */

exports.login = async (req, res) => {
  const { loginOrEmail, password } = req.body;

  if (!loginOrEmail || !password) {
    return res.status(400).json({ message: 'Login/email et mot de passe requis.' });
  }

  try {
    // 1) Trouver l’utilisateur actif par login OU email (partner)
    const user = await res_users.findOne({
      where: {
        active: true,
        [Op.or]: [
          { login: loginOrEmail },
          { '$partner.email$': loginOrEmail },
        ],
      },
      include: [{ model: res_partner, as: 'partner', required: false, attributes: ['name', 'email'] }],
    });

    if (!user) {
      return res.status(404).json({ message: 'Utilisateur introuvable ou inactif.' });
    }

    // 2) Vérifier le mot de passe
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Mot de passe incorrect.' });
    }

    // 3) Récupérer les groupes et inférer le rôle
    const links = await res_users_res_groups_rel.findAll({ where: { uid: user.id }, attributes: ['gid'] });
    const groups = await res_groups.findAll({ where: { id: links.map(l => l.gid) }, attributes: ['name'] });
    const role = inferRoleFromGroups(groups).toUpperCase();  // ADMIN | AGENT | CLIENT

    // 4) JWT —> durée 3h
    const token = jwt.sign(
      {
        id: user.id,
        name: user.partner?.name || user.login,
        email: user.partner?.email || user.login,
        role,
        partner_id: user.partner_id,
      },
      process.env.JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_TTL } // <<< 3 heures
    );

    res.status(200).json({
      token,
      role,
      user: {
        id: user.id,
        login: user.login,
        name: user.partner?.name,
        email: user.partner?.email,
        avatar: user.partner?.image || null,
        role,
      },
    });
  } catch (err) {
    console.error('💥 Erreur serveur:', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
};

/* ------------------------------- User stats ------------------------------ */

exports.getUserStats = async (req, res) => {
  try {
    const adminGroup = await res_groups.findOne({
      where: { name: { [Op.iLike]: 'admin' } },
    });

    let adminUserIds = [];
    if (adminGroup) {
      const relations = await res_users_res_groups_rel.findAll({
        where: { gid: adminGroup.id },
        attributes: ['uid'],
      });
      adminUserIds = relations.map((rel) => rel.uid);
    }

    const users = await res_users.findAll({
      where: {
        id: { [Op.notIn]: adminUserIds },
      },
      attributes: ['id', 'login', 'active'],
      include: [{ model: res_partner, attributes: ['email'], as: 'partner' }],
    });

    res.status(200).json({
      totalUsers: users.length,
      users,
    });
  } catch (error) {
    console.error('❌ Erreur dans getUserStats:', error);
    res.status(500).json({ message: 'Erreur serveur' });
  }
};

/* ------------------------------ Get by ID ------------------------------- */

exports.getUserById = async (req, res) => {
  try {
    const id = req.params.id;

    const user = await res_users.findOne({
      where: { id },
      attributes: ['id', 'login', 'active', 'partner_id'],
      include: [{ model: res_partner, attributes: ['email', 'name'], as: 'partner' }],
    });

    if (!user) return res.status(404).json({ message: 'Utilisateur introuvable' });

    const links = await res_users_res_groups_rel.findAll({ where: { uid: user.id }, attributes: ['gid'] });
    const groups = await res_groups.findAll({ where: { id: links.map(l => l.gid) }, attributes: ['name'] });
    const role = inferRoleFromGroups(groups); // 'admin' | 'agent' | 'client'

    res.status(200).json({
      id: user.id,
      login: user.login,
      email: user.partner?.email || null,
      active: user.active,
      role,
    });
  } catch (error) {
    console.error('Erreur dans getUserById:', error);
    res.status(500).json({ message: 'Erreur serveur' });
  }
};

/* ------------------------------ Update user ----------------------------- */

// controllers/auth.controller.js
exports.updateUser = async (req, res) => {
  const { id } = req.params;
  const { active, login, email, name, password } = req.body || {};

  try {
    // Permissions (suppose un middleware JWT qui remplit req.user)
    const requester = req.user || {};
    const isAdmin = (requester.role || "").toUpperCase() === "ADMIN";
    const isSelf = String(requester.id || "") === String(id);

    if (!isSelf && !isAdmin) {
      return res.status(403).json({ message: "⛔ Accès refusé" });
    }

    // Charger l'utilisateur + partner
    const user = await res_users.findByPk(id, {
      include: [{ model: res_partner, as: "partner", attributes: ["id", "name", "email"] }],
    });
    if (!user) return res.status(404).json({ message: "Utilisateur introuvable" });

    // Préparer updates
    const userUpdates = {};
    const partnerUpdates = {};

    // --- ACTIVE (admin only) ---
    if (typeof active !== "undefined") {
      if (!isAdmin) {
        return res.status(403).json({ message: "Seul un ADMIN peut changer le statut actif/inactif." });
      }
      userUpdates.active = !!active;
    }

    // --- LOGIN (unicité) ---
    if (typeof login !== "undefined" && login !== user.login) {
      const exists = await res_users.findOne({
        where: { login, id: { [Op.ne]: user.id } },
        attributes: ["id"],
      });
      if (exists) return res.status(409).json({ message: "Login déjà utilisé." });
      userUpdates.login = login;
    }

    // --- EMAIL + NAME (stockés aussi côté partner) ---
    if (typeof email !== "undefined" && email !== user.partner?.email) {
      userUpdates.email = email;             // si tu tiens une colonne email sur res_users
      partnerUpdates.email = email;          // source de vérité côté partner
    }
    if (typeof name !== "undefined" && name !== user.partner?.name) {
      partnerUpdates.name = name;
    }

    // --- PASSWORD (hash) ---
    if (typeof password !== "undefined" && password) {
      if (!isSelf && !isAdmin) {
        return res.status(403).json({ message: "Seul l'utilisateur ou un ADMIN peut changer le mot de passe." });
      }
      const hashed = await bcrypt.hash(password, 10);
      userUpdates.password = hashed;
    }

    // Rien à faire ?
    if (
      !Object.keys(userUpdates).length &&
      !Object.keys(partnerUpdates).length
    ) {
      return res.status(200).json({ message: "Aucune modification." });
    }

    // Transaction
    await sequelize.transaction(async (t) => {
      if (Object.keys(userUpdates).length) {
        await user.update(userUpdates, { transaction: t });
      }
      if (Object.keys(partnerUpdates).length) {
        await res_partner.update(partnerUpdates, { where: { id: user.partner_id }, transaction: t });
      }
    });

    // Recharger pour la réponse
    const refreshed = await res_users.findByPk(id, {
      include: [{ model: res_partner, as: "partner", attributes: ["name", "email"] }],
    });

    return res.status(200).json({
      message: `✅ Utilisateur ${refreshed.login} mis à jour.`,
      user: {
        id: refreshed.id,
        login: refreshed.login,
        email: refreshed.partner?.email || null,
        name: refreshed.partner?.name || null,
        active: refreshed.active,
      },
    });
  } catch (error) {
    console.error("Erreur dans updateUser:", error);
    return res.status(500).json({ message: "Erreur serveur interne." });
  }
};


/* ------------------------------- Get clients ---------------------------- */

exports.getClients = async (req, res) => {
  try {
    const users = await res_users.findAll({
      attributes: ['id', 'login', 'active', 'partner_id'],
      include: [
        {
          model: res_groups,
          as: 'groups',
          required: true,
          where: {
            [Op.or]: GROUP_ALIASES.client.map(n => ({ name: { [Op.iLike]: `%${n}%` } })),
          },
          attributes: [],
          through: { attributes: [] },
        },
        { model: res_partner, as: 'partner', attributes: ['email', 'name'] },
      ],
      order: [[{ model: res_partner, as: 'partner' }, 'name', 'ASC']],
    });

    res.status(200).json(users);
  } catch (error) {
    console.error('Erreur getClients :', error);
    res.status(500).json({ message: 'Erreur serveur', error });
  }
};

/* ------------------------------ Google login ---------------------------- */

exports.googleLogin = async (req, res) => {
  const { credential } = req.body;

  try {
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: '643716741024-b17obejeud2ksngkbj3722smrttnkk0d.apps.googleusercontent.com',
    });
    const payload = ticket.getPayload(); // { email, name, picture, ... }

    // Chercher par email de partner
    let user = await res_users.findOne({
      include: [{ model: res_partner, as: 'partner', where: { email: payload.email } }],
    });

    if (!user) {
      // Créer partner
      const lastPartner = await res_partner.findOne({ order: [['id', 'DESC']] });
      const nextPartnerId = (lastPartner?.id || 0) + 1;

      const partner = await res_partner.create({
        id: nextPartnerId,
        name: payload.name,
        email: payload.email,
        phone: null,
      });

      // Créer user actif
      user = await res_users.create({
        login: payload.email.split('@')[0],
        email: payload.email,
        password: 'GoogleAuth',
        active: true,
        partner_id: partner.id,
      });

      // Ajouter au groupe client
      const clientGroups = await res_groups.findAll({
        where: { [Op.or]: GROUP_ALIASES.client.map(n => ({ name: { [Op.iLike]: `%${n}%` } })) },
        attributes: ['id'],
      });
      if (clientGroups.length) {
        await res_users_res_groups_rel.bulkCreate(
          clientGroups.map(g => ({ uid: user.id, gid: g.id })),
          { ignoreDuplicates: true }
        );
      }
    }

    // Déduire le rôle réel
    const links = await res_users_res_groups_rel.findAll({ where: { uid: user.id }, attributes: ['gid'] });
    const groups = await res_groups.findAll({ where: { id: links.map(l => l.gid) }, attributes: ['name'] });
    const role = inferRoleFromGroups(groups).toUpperCase();

    // JWT Google —> durée 3h
    const token = jwt.sign(
      {
        id: user.id,
        name: user.partner?.name || user.login,
        email: user.partner?.email || user.login,
        role,
        partner_id: user.partner_id,
      },
      process.env.JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_TTL } // <<< 3 heures
    );

    res.status(200).json({ token, role, user });
  } catch (err) {
    console.error('Erreur Google Auth :', err);
    res.status(401).json({ message: 'Token Google invalide' });
  }
};

/* ------------------------------ List clients ---------------------------- */

exports.listClients = async (req, res) => {
  try {
    const { groupName = 'Client', search = '' } = req.query;

    const rows = await res_users.findAll({
      attributes: [['id', 'value'], ['login', 'label'], 'partner_id'],
      include: [
        {
          model: res_groups,
          as: 'groups',
          required: true,
          where: { name: { [Op.iLike]: `%${groupName}%` } },
          attributes: [],
          through: { attributes: [] },
        },
      ],
      where: search
        ? {
            [Op.or]: [
              { login: { [Op.iLike]: `%${search}%` } },
              { email: { [Op.iLike]: `%${search}%` } },
            ],
          }
        : undefined,
      order: [['login', 'ASC']],
      limit: 100,
    });

    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: 'Erreur clients', error: e.message });
  }
};
