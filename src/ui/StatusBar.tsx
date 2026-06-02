// Status bar: "ready" / "disconnected" word + hints. Spinner is shown
// when busy.

import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { ToolSupportPill } from './Banner.js';
import type { TranscriptFilter, UiPhase } from './state.js';

export interface StatusProps {
  busy: boolean;
  apiReady: boolean;
  activeSkill: string | null;
  yolo: boolean;
  ctxTokens: number;
  compactThreshold: number;
  memoryItems: number;
  /** Live model + tool-support, surfaced here since the banner (printed
   *  once into scrollback) can't reflect post-launch changes. */
  model?: string;
  toolSupport?: ToolSupportPill;
  phase: UiPhase;
  transcriptFilter: TranscriptFilter;
  target?: string;
  /** True when a collapsible tool-result hasn't been expanded yet (Ctrl-O reprints it). */
  expandHint: boolean;
}

function toolPill(t?: ToolSupportPill): { text: string; color: string } | null {
  switch (t) {
    case 'yes':
      return { text: 'tools ✓', color: 'green' };
    case 'no':
      return { text: 'NO TOOLS', color: 'red' };
    case 'probing':
      return { text: 'probing…', color: 'yellow' };
    default:
      return null;
  }
}

export function StatusBar(props: StatusProps): React.ReactElement {
  const phaseText = phaseLabel(props.phase);
  if (props.busy) {
    return (
      <Box>
        <Text color="yellow">
          <Spinner type="dots" />
        </Text>
        <Text color="gray"> {phaseText} · Esc to cancel</Text>
        {props.activeSkill ? <Text color="gray"> · skill: {props.activeSkill}</Text> : null}
      </Box>
    );
  }

  const ctxHint =
    props.ctxTokens >= 1000
      ? `  ·  ctx: ~${(props.ctxTokens / 1000).toFixed(1)}k`
      : props.ctxTokens > 0
        ? `  ·  ctx: ~${props.ctxTokens}`
        : '';
  const ctxPercent =
    props.compactThreshold > 0 && props.ctxTokens > 0
      ? Math.min(999, Math.round((props.ctxTokens / props.compactThreshold) * 100))
      : 0;
  const pill = toolPill(props.toolSupport);

  return (
    <Box>
      {props.apiReady ? (
        <Text color="green" bold>
          ready
        </Text>
      ) : (
        <Text color="red" bold>
          disconnected
        </Text>
      )}
      <Text color="gray"> · {phaseText} · Enter send · / commands</Text>
      {props.model ? <Text color="gray"> · {props.model}</Text> : null}
      {props.target ? <Text color="gray"> · target: {compactTarget(props.target)}</Text> : null}
      {pill ? <Text color={pill.color}> [{pill.text}]</Text> : null}
      {props.expandHint ? <Text color="cyan"> · Ctrl-O expand output</Text> : null}
      {props.transcriptFilter !== 'all' ? (
        <Text color="cyan"> · filter: {props.transcriptFilter}</Text>
      ) : null}
      {props.activeSkill ? <Text color="gray"> · skill: {props.activeSkill}</Text> : null}
      {ctxHint ? (
        <Text color={ctxPercent >= 90 ? 'yellow' : 'gray'}>
          {ctxHint}
          {ctxPercent ? `/${Math.round(props.compactThreshold / 1000)}k ${ctxPercent}%` : ''}
        </Text>
      ) : null}
      {props.memoryItems > 0 ? <Text color="gray"> · mem: {props.memoryItems}</Text> : null}
      {props.yolo ? (
        <Text color="red" bold>
          {'  ·  YOLO'}
        </Text>
      ) : null}
    </Box>
  );
}

function phaseLabel(phase: UiPhase): string {
  switch (phase) {
    case 'planning':
      return 'planning';
    case 'running-tool':
      return 'running tool';
    case 'answering':
      return 'answering';
    case 'waiting-approval':
      return 'waiting approval';
    case 'waiting-user':
      return 'waiting input';
    case 'skills':
      return 'skills';
    case 'idle':
      return 'idle';
  }
}

function compactTarget(target: string): string {
  return target.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
