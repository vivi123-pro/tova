import "dotenv/config";
import { createApp } from "./app.js";
import { db } from "./db.js";

const app = createApp(db);
const PORT = Number(process.env.PORT) || 4000;

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Tova API running on http://localhost:${PORT}`);
});
