import * as React from "react";
import {
  ChevronDown,
  ChevronRight,
  InfinityIcon,
  LoaderCircle,
  ListTodo,
  Square
} from "lucide-react";
import type { ModeKind } from "./types";

export function SendIcon(): React.JSX.Element {
  return (
    <svg className="send-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 21V3" />
      <path d="m5 10 7-7 7 7" />
    </svg>
  );
}

export function StopIcon(): React.JSX.Element {
  return <Square className="send-icon stop-icon" strokeWidth={2.7} />;
}

export function ChevronIcon(): React.JSX.Element {
  return <ChevronDown className="chevron" strokeWidth={2.1} />;
}

export function ItemArrowIcon(): React.JSX.Element {
  return <ChevronRight className="item-arrow" strokeWidth={2.1} />;
}

export function ThoughtChevronIcon(): React.JSX.Element {
  return <ChevronDown className="thought-chevron" strokeWidth={2.1} />;
}

export function ModeIcon({ kind }: { kind: ModeKind }): React.JSX.Element {
  if (kind === "build") {
    return <InfinityIcon className="mode-icon" strokeWidth={2.1} />;
  }

  if (kind === "plan") {
    return <ListTodo className="mode-icon" strokeWidth={2.1} />;
  }

  return <LoaderCircle className="mode-icon mode-icon-spinner" strokeWidth={2.1} />;
}
