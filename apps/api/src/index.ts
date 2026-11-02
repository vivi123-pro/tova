import "dotenv/config";
import { createDemoApp } from "./demo-app.js";
import { db } from "./db.js";

const app = createDemoApp(db);
const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.NODE_ENV === "production" ? "0.0.0.0" : process.env.HOST ?? "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`Tova API listening on ${HOST}:${PORT}`);
});
