type Messages = Record<string, string>;
type Catalog = Record<string, Messages>;

const catalogs = new Map<string, Catalog>();
let activeLocale = "en";

export function scope(namespace: string): (key: string, fallback: string) => string {
  return (key, fallback) => catalogs.get(namespace)?.[activeLocale]?.[key] ?? fallback;
}

export function registerStrings(namespace: string, catalog: Catalog): void {
  catalogs.set(namespace, catalog);
}

export function registerLocalesFromDir(): void {}

export function applyLocale(locale: string): void {
  activeLocale = locale;
}
