import { BackendApplication, BackendApplicationConfigProvider } from "@theia/core/lib/node";
import { Container } from "@theia/core/shared/inversify";

export default async function (): Promise<void> {
  const config = BackendApplicationConfigProvider.get();
  const container = new Container({ skipBaseClassChecks: true });
  const app = new BackendApplication(container, config);
  await app.start();
}
