import { Fragment, type ReactNode } from 'react';
import { renderWithKeywords } from './Keywords';
import CardNameRef from './CardNameRef';
import type { CardCatalog } from '../cardCatalog';

/**
 * Render card-description text with two kinds of inline decorations:
 *   - Game keyword tooltips (via renderWithKeywords).
 *   - Card-name references — dotted underline + hover preview of the
 *     referenced CardFull.
 *
 * Self-references (the card naming itself) are left as plain text so the
 * name's own card doesn't link back to itself.
 */
export function renderDescription(
  text: string,
  catalog: CardCatalog,
  selfDefinitionId?: string,
): ReactNode {
  if (!text) return null;
  const pattern = catalog.namePattern;
  if (!pattern) return renderWithKeywords(text);

  pattern.lastIndex = 0;

  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const matched = match[0];
    const referenced = catalog.getCardByName(matched);
    // Unknown / self-reference — leave the match as ordinary text; it will
    // be included in the next "text before match" slice or the trailing
    // slice and still run through the keyword renderer.
    if (!referenced || referenced.definition_id === selfDefinitionId) continue;

    if (match.index > lastIndex) {
      parts.push(
        <Fragment key={`k-${lastIndex}`}>
          {renderWithKeywords(text.slice(lastIndex, match.index))}
        </Fragment>,
      );
    }

    parts.push(
      <CardNameRef key={`c-${match.index}`} text={matched} card={referenced} />,
    );

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(
      <Fragment key={`k-${lastIndex}`}>
        {renderWithKeywords(text.slice(lastIndex))}
      </Fragment>,
    );
  }

  return parts.length > 0 ? <>{parts}</> : renderWithKeywords(text);
}
