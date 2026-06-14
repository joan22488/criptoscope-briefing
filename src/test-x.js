import "dotenv/config";
import { TwitterApi } from "twitter-api-v2";

console.log("X_API_KEY:", process.env.X_API_KEY?.slice(0, 8) + "...");
console.log("X_ACCESS_TOKEN:", process.env.X_ACCESS_TOKEN?.slice(0, 12) + "...");

const client = new TwitterApi({
  appKey: process.env.X_API_KEY,
  appSecret: process.env.X_API_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_SECRET,
});

// Test v1.1 primero (más básico)
try {
  const creds = await client.v1.verifyCredentials();
  console.log("✅ v1.1 OK — usuario:", creds.screen_name);
} catch (e) {
  console.error("❌ v1.1 Error:", e.message);
  if (e.data) console.error("   v1.1 Data:", JSON.stringify(e.data, null, 2));
}

// Test v2
try {
  const me = await client.v2.me();
  console.log("✅ v2 OK — usuario:", me.data.username);
} catch (e) {
  console.error("❌ v2 Error:", e.message);
  if (e.data) console.error("   v2 Data:", JSON.stringify(e.data, null, 2));
}
