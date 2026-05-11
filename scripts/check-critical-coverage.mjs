import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const summaryPath = path.resolve(process.cwd(), "coverage", "coverage-summary.json");

if (!fs.existsSync(summaryPath)) {
  console.error(`[critical-coverage] Missing coverage summary at ${summaryPath}`);
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));

const CRITICAL_THRESHOLDS = {
  agents: {
    "src/agents/loop.ts": {
      lines: 65,
      statements: 65,
      functions: 25,
      branches: 50,
    },
    "src/agents/consensus.ts": {
      lines: 50,
      statements: 50,
      functions: 70,
      branches: 40,
    },
    "src/agents/output-contracts.ts": {
      lines: 70,
      statements: 70,
      functions: 70,
      branches: 55,
    },
    "src/agents/tool-delegation.ts": {
      lines: 70,
      statements: 70,
      functions: 70,
      branches: 55,
    },
  },
  memory: {
    "src/memory/acl.ts": {
      lines: 95,
      statements: 95,
      functions: 95,
      branches: 90,
    },
    "src/memory/dedup.ts": {
      lines: 95,
      statements: 95,
      functions: 95,
      branches: 95,
    },
    "src/memory/pinning.ts": {
      lines: 95,
      statements: 95,
      functions: 95,
      branches: 70,
    },
  },
  security: {
    "src/security/data-residency.ts": {
      lines: 95,
      statements: 95,
      functions: 95,
      branches: 90,
    },
    "src/security/intrusion-detection.ts": {
      lines: 90,
      statements: 90,
      functions: 85,
      branches: 85,
    },
    "src/security/prompt-injection.ts": {
      lines: 95,
      statements: 95,
      functions: 95,
      branches: 90,
    },
  },
};

const metricOrder = ["lines", "statements", "functions", "branches"];
const failures = [];
let checkedFiles = 0;

function findSummaryEntry(relativeFile) {
  return Object.entries(summary).find(([key]) => key.endsWith(relativeFile));
}

for (const [groupName, files] of Object.entries(CRITICAL_THRESHOLDS)) {
  console.log(`[critical-coverage] ${groupName}`);

  for (const [relativeFile, thresholds] of Object.entries(files)) {
    checkedFiles += 1;

    const match = findSummaryEntry(relativeFile);
    if (!match) {
      failures.push(`${relativeFile}: missing coverage entry`);
      console.log(`  FAIL ${relativeFile} missing coverage entry`);
      continue;
    }

    const [, metrics] = match;
    const fileFailures = [];
    const parts = metricOrder.map((metric) => {
      const actual = Number(metrics[metric]?.pct ?? 0);
      const threshold = thresholds[metric];
      if (actual < threshold) {
        fileFailures.push(`${metric} ${actual.toFixed(2)}% < ${threshold}%`);
      }
      return `${metric} ${actual.toFixed(2)}%/${threshold}%`;
    });

    if (fileFailures.length > 0) {
      failures.push(`${relativeFile}: ${fileFailures.join(", ")}`);
      console.log(`  FAIL ${relativeFile} ${parts.join(" | ")}`);
      continue;
    }

    console.log(`  PASS ${relativeFile} ${parts.join(" | ")}`);
  }
}

if (failures.length > 0) {
  console.error(`\n[critical-coverage] ${failures.length} check(s) failed.`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`\n[critical-coverage] Passed ${checkedFiles} critical file checks.`);
