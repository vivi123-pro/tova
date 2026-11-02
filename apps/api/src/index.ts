import "dotenv/config";
import { createDemoApp } from "./demo-app.js";
import { db } from "./db.js";

const app = createDemoApp(db);
const PORT = Number(process.env.PORT) || 4000;

app.listen(PORT, process.env.HOST ?? "0.0.0.0", () => {
  console.log(`Tova API running on http://localhost:${PORT}`);
});
