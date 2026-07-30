import { existsSync, readFileSync, statSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REVIEW_PROMPT = `Perform a brutally honest senior/staff engineer review of this codebase.

Determine whether this system is genuinely engineered or primarily "vibe coded". Where features work superficially but lack rigorous architecture, operational thinking, scalability planning, and long-term maintainability.

Evaluate:

- System design maturity
- Real-world production readiness
- Token/memory efficiency decisions
- Concurrency and lifecycle handling
- Failure-mode thinking
- Observability and debugging capability
- Data flow clarity
- Dependency hygiene
- Security posture
- Extensibility without collapse
- AI-generated code smells
- Consistency of patterns across the codebase

Highlight:

- Fake sophistication vs real engineering
- Clever-looking abstractions that hurt maintainability
- Premature optimization
- Missing operational safeguards
- Areas where senior engineers would immediately lose confidence

End with:

- What level engineer likely built this
- Whether this could survive production scale
- What would break first under growth
- Top 5 highest priority refactors`;

function buildFileReviewMessage(filePath: string): string {
    const content = readFileSync(filePath, "utf-8");
    return `File: \`${filePath}\`\n\n\`\`\`\n${content}\n\`\`\``;
}

function buildScopeReviewMessage(scope: string): string {
    return `Focus the review on the ${scope} directory/area.\n\n${REVIEW_PROMPT}`;
}

export default function (pi: ExtensionAPI) {
    pi.registerCommand("review", {
        description: "Brutally honest senior/staff engineer codebase review",
        getArgumentCompletions: (prefix) => {
            const scopes = ["full", "src", "lib", "test", "config"];
            const filtered = scopes.filter((s) => s.startsWith(prefix));
            return filtered.length > 0
                ? filtered.map((s) => ({ value: s, label: s === "full" ? "Full codebase" : s }))
                : null;
        },
        handler: async (args, ctx) => {
            const trimmed = args.trim();
            if (!trimmed || trimmed === "full") {
                if (!ctx.isIdle()) {
                    ctx.ui.notify("Agent is busy. Wait for it to finish, then try /review again.", "warning");
                    return;
                }
                ctx.ui.notify("Reviewing full codebase...", "info");
                pi.sendUserMessage(REVIEW_PROMPT);
                return;
            }

            if (!ctx.isIdle()) {
                ctx.ui.notify("Agent is busy. Wait for it to finish, then try /review again.", "warning");
                return;
            }

            // Parse arguments. The auto-review extension queues one file at a time,
            // but a user might type multiple paths manually.
            const scopes = trimmed.split(/\s+/).filter(Boolean);
            const fileScopes: string[] = [];
            const dirScopes: string[] = [];

            for (const scope of scopes) {
                if (existsSync(scope) && statSync(scope).isFile()) {
                    fileScopes.push(scope);
                } else {
                    dirScopes.push(scope);
                }
            }

            if (fileScopes.length > 0) {
                ctx.ui.notify(`Reviewing ${fileScopes.join(", ")}...`, "info");
                const parts = fileScopes.map((f) => buildFileReviewMessage(f));
                const message =
                    fileScopes.length === 1
                        ? `Review the following:\n\n${parts[0]}\n\n${REVIEW_PROMPT}`
                        : `Review the following files:\n\n${parts.join("\n\n")}\n\n${REVIEW_PROMPT}`;
                pi.sendUserMessage(message);
                return;
            }

            const scope = dirScopes[0] ?? "full";
            ctx.ui.notify(`Reviewing ${scope === "full" ? "full codebase" : scope}...`, "info");
            const message = buildScopeReviewMessage(scope);
            pi.sendUserMessage(message);
        },
    });
}