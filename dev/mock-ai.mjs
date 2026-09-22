// A stand in for the Foundry model, for local development and tests. It reads the transcript with a few regular
// expressions, so it is nothing like a real model, but it returns the same shape and exercises the whole flow
// (proposal, evidence quotes, review, save) without Azure. The page says "demo" whenever this is in use.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const sentences = (t) => t.replace(/\s+/g, " ").match(/[^.!?]+[.!?]?/g)?.map((s) => s.trim()).filter(Boolean) ?? [];

export function createMockAi() {
  return {
    kind: "mock",
    deployment: "mock",
    async extract({ context }) {
      const { mode, transcript, target, opps, today } = context;
      const sents = sentences(transcript);
      const find = (re) => sents.find((s) => re.test(s));
      const changes = [];
      const push = (field, value, quote) => { if (quote && !changes.some((c) => c.field === field)) changes.push({ field, value: String(value), quote: quote.slice(0, 200) }); };

      let match = { oppId: null, confidence: "none", reason: "Demo mode." };
      let cur = target;
      if (mode === "update" && !target) {
        const low = transcript.toLowerCase();
        const hit = opps.find((o) => low.includes(String(o.account).toLowerCase()));
        if (hit) { cur = hit; match = { oppId: hit.id, confidence: "high", reason: `The transcript mentions ${hit.account}.` }; }
      }

      if (mode === "new" || cur) {
        if (mode === "new") {
          const m = /(?:customer|account|company)\s*:\s*([A-Z][\w&.\- ]{1,60})/i.exec(transcript) || /\bwith\s+([A-Z][A-Za-z0-9&.\-]+(?:\s+[A-Z][A-Za-z0-9&.\-]+){0,3})/.exec(transcript);
          if (m) push("account", m[1].trim(), find(new RegExp(m[1].trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))));
        }
        const money = sents.find((s) => /\$\s?[\d,.]+(?:\s?(?:k|m|million|thousand)\b)?/i.test(s));
        if (money) push("size", /\$\s?([\d,.]+(?:\s?(?:k|m|million|thousand)\b)?)/i.exec(money)[1].replace(/\s+/g, ""), money);
        const prop = find(/\b(proposal|rfp|quote)\b/i);
        if (prop) push("stage", "Proposal / RFP", prop);
        const won = find(/\b(we (?:have )?signed|has signed|have signed|verbal award|po (?:was )?issued|purchase order (?:was )?issued)\b/i);
        if (won) push("stage", "Won", won);
        const lost = find(/\b(went with a competitor|cancelled|canceled|no longer pursuing)\b/i);
        if (lost) push("stage", "Lost", lost);
        const dateSent = find(/\b(?:by|before|close[sd]?(?: on| by)?)\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}/i);
        if (dateSent) {
          const m = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/i.exec(dateSent);
          const year = m[3] ?? today.slice(0, 4);
          push("closeDate", `${year}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`, dateSent);
        }
        const next = find(/next step/i);
        if (next) push("nextStep", next.replace(/^.*?next steps?\s*(?:is|are|:)?\s*/i, "").replace(/[.]$/, ""), next);
        const tw = find(/thoughtworks/i);
        if (tw && /joined|on the call|engaged|partnering/i.test(tw)) push("tw", "Engaged", tw);
      }

      return {
        match,
        summary: sents.slice(0, 4).join(" "),
        decisions: sents.filter((s) => /\b(decided|agreed|approved)\b/i.test(s)).slice(0, 4),
        actionItems: sents.filter((s) => /\b(will send|will follow up|action item|to send)\b/i.test(s)).slice(0, 5),
        risks: sents.filter((s) => /\b(risk|concern|budget freeze|blocker)\b/i.test(s)).slice(0, 3),
        changes,
      };
    },
  };
}
