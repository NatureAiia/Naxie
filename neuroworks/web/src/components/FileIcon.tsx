// Atom Material Icons (VSCode Material Icon Theme, self-hosted via the
// `vscode-material-icons` npm package — MIT). SVGs live in
// public/material-icons/ (copied from node_modules/vscode-material-icons/
// generated/icons; re-run `cp -r node_modules/vscode-material-icons/generated/icons/* public/material-icons/`
// after bumping the package to refresh them).
import { getIconForFilePath, getIconForDirectoryPath, getIconUrlByName, type MaterialIcon } from "vscode-material-icons";

const ICONS_URL = "/material-icons";

export function FileIcon({ path, isDirectory = false, size = 16, className }: { path: string; isDirectory?: boolean; size?: number | string; className?: string }) {
  const name = isDirectory ? getIconForDirectoryPath(path) : getIconForFilePath(path);
  const url = getIconUrlByName(name, ICONS_URL);
  return <img src={url} alt="" width={size} height={size} className={className} />;
}

export function NamedIcon({ name, size = 16, className }: { name: MaterialIcon; size?: number | string; className?: string }) {
  const url = getIconUrlByName(name, ICONS_URL);
  return <img src={url} alt="" width={size} height={size} className={className} />;
}

// Wraps a named Atom Material icon so it can drop into any spot expecting a
// lucide-style `<Icon size={..} className={..} />` component (nav rails,
// command palette) without special-casing the render call site. size?:
// number|string mirrors lucide-react's own LucideProps so both icon
// families satisfy the same ComponentType in NavItem/renderGroup.
export function matIcon(name: MaterialIcon) {
  return function MatIcon({ size = 16, className }: { size?: number | string; className?: string }) {
    return <NamedIcon name={name} size={size} className={className} />;
  };
}
