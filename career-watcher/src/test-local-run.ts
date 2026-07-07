import { executeCompanyScrapeBatch } from './browser/search-runner';
import * as dotenv from 'dotenv';

dotenv.config();

async function run() {
  console.log("Starting test for Hybrid Local-First scraper flow...");
  console.log("TINYFISH_API_KEY is present:", !!process.env.TINYFISH_API_KEY);

  // Search 1: Successful local query (Apple Careers - India)
  // This should run locally and find jobs, NOT falling back to TinyFish.
  const payloadSuccessful = {
    company: "apple",
    careerUrl: "https://jobs.apple.com/us/search",
    searches: [
      {
        searchId: "test-apple-payroll-specialist",
        role: "Payroll Specialist",
        location: "india"
      }
    ]
  };

  console.log("\n=== TEST 1: EXPECTED LOCAL SUCCESS ===");
  const results1 = await executeCompanyScrapeBatch(payloadSuccessful, (msg) => {
    console.log(`[LOG] ${msg}`);
  });
  console.log("Test 1 Results:", JSON.stringify(results1, null, 2));

  // Search 2: Non-existent query
  // This will yield 0 jobs locally, triggering the TinyFish fallback.
  const payloadEmpty = {
    company: "apple",
    careerUrl: "https://jobs.apple.com/us/search",
    searches: [
      {
        searchId: "test-apple-non-existent",
        role: "NonExistentSpecialistRoleXYZ",
        location: "india"
      }
    ]
  };

  console.log("\n=== TEST 2: EXPECTED TINYFISH FALLBACK ===");
  const results2 = await executeCompanyScrapeBatch(payloadEmpty, (msg) => {
    console.log(`[LOG] ${msg}`);
  });
  console.log("Test 2 Results:", JSON.stringify(results2, null, 2));
}

run().catch(err => {
  console.error("Test execution failed:", err);
});
