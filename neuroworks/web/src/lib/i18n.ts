export type Language = "en";

const strings: Record<Language, Record<string, string>> = {
  en: {
    "app.title": "NeuroWorks",
    "app.tagline": "The Intelligent Organization",
    "app.subtitle": "Describe what you want done, delegate, get results.",
    "dashboard.welcome": "Welcome to",
    "dashboard.quickStart": "Quick start",
    "dashboard.quickStart.persona": "tasks tuned for",
    "dashboard.viewAll": "View all templates",
    "dashboard.hire": "Hire an employee",
    "dashboard.hire.active": "currently working as",
    "dashboard.hire.none": "no employee active",
    "dashboard.recentActivity": "Recent activity",
    "dashboard.noTasks": "No tasks yet. Pick one above to delegate something.",
    "dashboard.workforce": "Workforce",
    "dashboard.inputPlaceholder": "Describe your task — e.g., Summarize the scraper-hub project",
    "dashboard.delegate": "Delegate",
    "dashboard.routing": "Routing…",
    "dashboard.zimbabweContext": "Zimbabwe Context",
    "dashboard.zimbabweContextDesc": "Your intelligent organization is tuned for the Zimbabwe market. Here's what you should know about your sector.",
    "onboarding.title": "Configure your Intelligent Organization",
    "onboarding.subtitle": "Help us tailor NeuroWorks to your needs",
    "onboarding.sector": "What sector do you operate in?",
    "onboarding.sectorDesc": "This helps us pre-configure templates, integrations, and knowledge packs for your industry.",
    "onboarding.orgName": "Organization name",
    "onboarding.orgNamePlaceholder": "e.g., Rubiem Developers",
    "onboarding.finish": "Get started",
    "onboarding.next": "Next",
    "onboarding.back": "Back",
    "onboarding.skipped": "Skip for now",
    "onboarding.done": "Your Intelligent Organization is ready",
    "onboarding.doneDesc": "You can change these settings anytime in Settings.",
  },
};

export function t(key: string, lang?: Language): string {
  return strings[lang ?? "en"]?.[key] ?? strings.en[key] ?? key;
}
