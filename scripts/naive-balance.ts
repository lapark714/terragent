/** Print the Naïve credit balance: npx tsx scripts/naive-balance.ts */
import "dotenv/config";
import { getNaive } from "../src/lib/naive/client";

const client = await getNaive();
const { balance_micro_usd } = await client.credits.show();
console.log(`balance USD ${(balance_micro_usd / 1e6).toFixed(2)}`);
process.exit(0);
