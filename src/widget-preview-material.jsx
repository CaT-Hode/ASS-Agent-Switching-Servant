import React, { useLayoutEffect, useRef } from 'react';
import backdrop from './assets/widget-demo.webp';
import { createWidgetPreviewOptics } from './widget-preview-optics.mjs';
import './widget-preview-material.css';

export function WidgetPreviewMaterial({ panel, radius, bezelWidth, distortion, scale, theme }) {
  const canvas = useRef(null), redraw = useRef(null), options = useRef(null);
  useLayoutEffect(() => {
    options.current = { radius, bezelWidth, distortion, scale, theme };
    redraw.current?.();
  }, [radius, bezelWidth, distortion, scale, theme]);
  useLayoutEffect(() => {
    const node = canvas.current, image = new Image();
    let renderer, frame;
    const draw = () => {
      if (!renderer || frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (panel.current) renderer.draw(panel.current, options.current);
      });
    };
    redraw.current = draw;
    const observer = new ResizeObserver(draw);
    observer.observe(node.parentElement);
    if (panel.current) observer.observe(panel.current);
    image.onload = () => { renderer = createWidgetPreviewOptics(node, image); draw(); };
    image.src = backdrop;
    return () => {
      redraw.current = null;
      image.onload = null;
      observer.disconnect();
      cancelAnimationFrame(frame);
      renderer?.dispose();
    };
  }, [panel]);
  return <canvas className="widget-demo-material" aria-hidden="true" ref={canvas} />;
}
