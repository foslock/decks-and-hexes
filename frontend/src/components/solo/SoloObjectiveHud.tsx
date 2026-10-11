import type { GameState } from '../../types/game';
import Icon from '../../icons/Icon';

/**
 * A solo level's objective in the game's top-left panel: the goal, your
 * progress toward it, and the rounds left (replacing "VP to win").
 */
export default function SoloObjectiveHud({ gameState }: { gameState: GameState }) {
  const solo = gameState.solo;
  if (!solo) return null;
  const obj = solo.objective;
  const progress = solo.progress;
  const round = gameState.current_round;
  // Rounds still to play, this one included (none: no time limit).
  const left = obj.rounds === null ? null : Math.max(0, obj.rounds - round + 1);
  const pct = progress ? Math.min(100, Math.round((progress.value / Math.max(1, progress.target)) * 100)) : 0;
  return (
    <div className="cc-solo-hud" title={obj.text}>
      <div className="cc-solo-hud-level">{solo.level_title}</div>
      <div className="cc-solo-hud-goal">{obj.headline ?? obj.goal}</div>
      {progress && (
        <div className="cc-solo-hud-progress" aria-label={`${progress.value} of ${progress.target} ${progress.unit}`}>
          <div className={`cc-solo-hud-bar${progress.met ? ' is-met' : progress.failed ? ' is-failed' : ''}`}>
            <i style={{ width: `${pct}%` }} />
          </div>
          <span className="cc-solo-hud-count">
            {obj.type === 'vp' && <Icon name="vp" size={11} decorative color="var(--cc-gold)" />}
            {progress.value}/{progress.target}
            {obj.type !== 'vp' && <small> {progress.unit}</small>}
          </span>
        </div>
      )}
      {progress?.detail && (
        <div className={`cc-solo-hud-detail${progress.failed ? ' is-failed' : ''}`}>{progress.detail}</div>
      )}
      <div className={`cc-solo-hud-rounds${left !== null && left <= 1 ? ' is-last' : ''}`}>
        <Icon name="round" size={11} decorative />
        {left === null ? ' No time limit' : left <= 1 ? ' Last round' : ` ${left} rounds left`}
        {obj.bot_vp != null && <span className="cc-solo-hud-rival"> · rivals win at {obj.bot_vp} VP</span>}
      </div>
    </div>
  );
}
