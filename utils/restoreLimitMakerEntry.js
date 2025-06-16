const fs = require("fs");
const path = require("path");

const TARGET_FILE = path.join(__dirname, "..", "posicoes", "limitMakerEntry.js");
const BACKUP_FILE = TARGET_FILE + ".backup";

console.log("🔄 === RESTAURANDO BACKUP DO limitMakerEntry.js ===\n");

try {
  if (fs.existsSync(BACKUP_FILE)) {
    const backupContent = fs.readFileSync(BACKUP_FILE, "utf8");
    fs.writeFileSync(TARGET_FILE, backupContent);
    console.log("✅ Arquivo restaurado do backup com sucesso!");
    console.log("💡 O backup foi mantido em limitMakerEntry.js.backup");
  } else {
    console.error("❌ Arquivo de backup não encontrado!");
    process.exit(1);
  }
} catch (error) {
  console.error("❌ Erro ao restaurar backup:", error.message);
  process.exit(1);
}