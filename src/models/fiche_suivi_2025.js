module.exports = (sequelize, DataTypes) => {
  const FicheSuivi = sequelize.define('FicheSuivi2025', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    raw: { type: DataTypes.JSONB, allowNull: false },

    date_reception_demande: DataTypes.DATE,
    date_reception_echantillons: DataTypes.DATE,
    date_devis: DataTypes.DATE,
    date_confirmation: DataTypes.DATE,
    date_rapport: DataTypes.DATE,
    date_facturation: DataTypes.DATE,
    debut_essai: DataTypes.DATE,

    etat: DataTypes.TEXT,
    retour_client: DataTypes.BOOLEAN,
    nb_echantillons: DataTypes.INTEGER,

    year_demande: DataTypes.INTEGER,
    year_echant: DataTypes.INTEGER,
  }, {
    tableName: 'fiche_suivi_2025',
    timestamps: false,
  });

  return FicheSuivi;
};
