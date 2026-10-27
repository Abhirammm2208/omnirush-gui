// Stock mode (STOCK_ENV=1 when the app starts; nothing in the app turns it on): chats run stock OpenCode 2.x on
// GPT 6 Astra and nothing on top of it, as the CLI's src/stock.js. The engine gets its stock tools and system prompt:
// no OmniRush context, app tools, MCP servers, computer use, web search provider, Claude or other models, sandbox
// note, automatic compaction or wrap-up offer, and no install-log wrappers. Sign-in, the gateway broker (auth and
// routing only), capture and uploads, and the sandbox stay. Uploads keep the exact shape of any 2.x chat.

export const STOCK_ENV = "OMNIRUSH_FARM";
export const STOCK_PROVIDER = "omnirush";
export const STOCK_MODEL = "gpt-6-astra";

/** Whether this run is in stock mode. */
export function stockMode(env = process.env) {
  return ["1", "true", "on", "yes"].includes(String(env?.[STOCK_ENV] ?? "").trim().toLowerCase());
}

/** The switches the app already has, set for the whole run (the CLI's STOCK_SWITCHES). */
export const STOCK_SWITCHES = Object.freeze({
  [STOCK_ENV]: "1",
  OMNIRUSH_BEST_PRACTICES: "0",
  OMNIRUSH_WEB_SEARCH: "0",
  OMNIRUSH_SELF_CHECK: "0",
  OMNIRUSH_PROJECT_NOTES: "0",
  OMNIRUSH_CODE_DIAGNOSTICS: "0",
  OMNIRUSH_SMART_COMPACTION: "0",
  OMNIRUSH_BUILDATHON: "0",
  OMNIRUSH_COMPUTER_USE: "0",
  OMNIRUSH_PLACEMENTS: "0",
  OMNIRUSH_FOLLOW_UP_HINT: "0",
  // No install-log wrappers on the agent's PATH (host or sandbox): stock has none.
  OMNIRUSH_INSTALL_LOG: "0",
});

/** Sets the stock switches in `env` when it asks for stock mode; returns whether it does. */
export function applyStockSwitches(env = process.env) {
  if (!stockMode(env)) return false;
  Object.assign(env, STOCK_SWITCHES);
  return true;
}

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The engine's providers in stock mode: the gateway's, with GPT 6 Astra only and without our web search option.
 * Empty when the account's catalog has no GPT 6 Astra.
 */
export function stockProviders(specs) {
  return specs.flatMap((spec) => {
    if (spec.id !== STOCK_PROVIDER) return [];
    const models = spec.models.filter((model) => model.id === STOCK_MODEL).map((model) => {
      const config = isRecord(model.config) ? model.config : {};
      const { hostedWebSearch: _hosted, ...options } = isRecord(config.options) ? config.options : {};
      const { options: _options, ...rest } = config;
      return { ...model, config: { ...rest, ...(Object.keys(options).length ? { options } : {}) } };
    });
    return models.length ? [{ ...spec, models }] : [];
  });
}
