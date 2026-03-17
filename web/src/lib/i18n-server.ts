import en from "@/i18n/messages/en.json";

type Messages = typeof en;

export function getTranslations(_locale: string, namespace: string) {
  const ns = (en as Record<string, Record<string, string>>)[namespace];
  const fallbackNs = (en as Record<string, Record<string, string>>)[namespace];
  return (key: string): string => {
    return ns?.[key] || fallbackNs?.[key] || key;
  };
}
