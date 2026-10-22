// Draws only the rows on screen (plus a few above/below), so 100,000 rows scroll like 100.
// Fixed row height. Works with any data: you render each row from its index.
import { useEffect, useRef, useState } from 'react';
import { useElementSize } from './hooks';

export function VirtualList({ count, rowHeight, height = 480, overscan = 8, renderRow, className, style, ...rest }) {
  const [ref, size] = useElementSize();
  const [scrollTop, setScrollTop] = useState(0);
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const onScroll = (e) => {
    const top = e.currentTarget.scrollTop;
    if (frame.current) return; // at most one re-render per frame
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setScrollTop(top);
    });
  };

  const viewport = size.height || height;
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(count, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
  const items = [];
  for (let i = first; i < last; i++) {
    items.push(
      <div
        key={i}
        role="listitem"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          height: rowHeight,
          transform: `translateY(${i * rowHeight}px)`,
        }}
      >
        {renderRow(i)}
      </div>,
    );
  }

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      tabIndex={0}
      className={className}
      style={{
        height,
        overflowY: 'auto',
        position: 'relative',
        contain: 'strict',
        overscrollBehavior: 'contain',
        ...style,
      }}
      {...rest}
    >
      <div role="list" style={{ height: count * rowHeight, position: 'relative' }}>
        {items}
      </div>
    </div>
  );
}
