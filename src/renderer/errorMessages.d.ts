export declare const ERROR_I18N_KEY_BY_CODE: Readonly<Record<string, string>>
export declare function errorI18nKey (code: string | null | undefined, fallbackKey: string): string
export declare function errorCodeToI18nKey (code: string | null | undefined): string
export declare function mountErrorI18nKey (code: string | null | undefined): string | null
export declare function mountFaultReasonKey (code: string | null | undefined): string
