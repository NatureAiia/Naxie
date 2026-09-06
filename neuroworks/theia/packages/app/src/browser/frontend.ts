import "@theia/core/src/browser/style/index.css";

import { FrontendApplication, FrontendApplicationConfigProvider } from "@theia/core/lib/browser";
import { Container } from "@theia/core/shared/inversify";

export default async function (): Promise<void> {
  const config = FrontendApplicationConfigProvider.get();
  const container = new Container({ skipBaseClassChecks: true });
  const app = new FrontendApplication(container, config);
  await app.start();
}
