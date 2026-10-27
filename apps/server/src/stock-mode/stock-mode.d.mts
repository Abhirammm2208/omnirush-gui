export declare const STOCK_ENV: "OMNIRUSH_FARM";
export declare const STOCK_PROVIDER: "omnirush";
export declare const STOCK_MODEL: "gpt-6-astra";
export declare const STOCK_SWITCHES: Readonly<Record<string, string>>;
export declare function stockMode(env?: Record<string, string | undefined>): boolean;
export declare function applyStockSwitches(env?: Record<string, string | undefined>): boolean;
export declare function stockProviders<T extends { id: string; models: { id: string; config?: Record<string, unknown> }[] }>(specs: T[]): T[];
