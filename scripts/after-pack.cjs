const fs = require('node:fs');
const path = require('node:path');

// electronDist copies the stock Electron tree, including its demo app; ODA ships only app.asar.
exports.default = async function afterPack(context) {
  const file = path.join(context.appOutDir, 'resources', 'default_app.asar');
  if (fs.existsSync(file)) fs.rmSync(file);
};
