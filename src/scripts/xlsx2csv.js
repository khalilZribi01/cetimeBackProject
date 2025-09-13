// xlsx2csv.js
const XLSX = require('xlsx');
const fs = require('fs');

const xlsx = 'src/data/Suivi des dossiers LL_08-09-2025 (1).xlsx';
const wb = XLSX.readFile(xlsx); // lit le classeur
wb.SheetNames.forEach((name) => {
  // parcourt chaque onglet
  const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { FS: ',' }); // séparateur virgule
  fs.writeFileSync(`${name.replace(/\s+/g, '_')}.csv`, csv, 'utf8');
  console.log('OK ->', `${name}.csv`);
});
