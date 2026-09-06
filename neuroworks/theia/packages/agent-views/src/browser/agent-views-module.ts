import { ContainerModule } from "@theia/core/shared/inversify";
import { WidgetFactory, FrontendApplicationContribution } from "@theia/core/lib/browser";
import { CommandContribution, MenuContribution, KeybindingContribution } from "@theia/core/lib/common";
import { AgentDockFactory } from "./agent-dock-factory";
import { AgentViewsContribution } from "./agent-views-contribution";
import "../src/browser/agent-views.css";

export default new ContainerModule((bind) => {
  // Agent dock widget factory
  bind(AgentDockFactory).toSelf().inSingletonScope();
  bind(WidgetFactory).toService(AgentDockFactory);

  // Application contributions (commands, menus, keybindings)
  bind(AgentViewsContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(AgentViewsContribution);
  bind(MenuContribution).toService(AgentViewsContribution);
  bind(KeybindingContribution).toService(AgentViewsContribution);
  bind(FrontendApplicationContribution).toService(AgentViewsContribution);
});
