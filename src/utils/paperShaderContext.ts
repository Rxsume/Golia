import type { PaperShaderElement } from '@paper-design/shaders';

// src/utils/paperShaderContext.ts
// Context options and teardown for full-screen paper-shaders backgrounds.

/**
 * The paper shaders draw one full-screen quad with no depth test, so WebGL's default 4x MSAA
 * and depth buffer only cost memory (about 72 MB for the two latent layers at 1280x720) and a
 * resolve per frame. readPixels output with and without them is identical, channel for channel.
 * paper-shaders reads this once, when the context is created.
 */
export const PAPER_SHADER_CONTEXT_ATTRIBUTES: WebGLContextAttributes = Object.freeze({
    antialias: false,
    depth: false,
});

/**
 * A ref for a paper shader's host element that gives the WebGL context back once the shader
 * unmounts. paper-shaders' dispose() deletes its program and removes the canvas, but never
 * loses the context, so the drawing buffers stay alive until the canvas happens to be
 * garbage-collected; switching visualizer modes a few times piled up hundreds of MB that way.
 *
 * The ref is detached before paper's own effect cleanup disposes the mount, so the context is
 * still reachable here. It is only lost after the canvas has actually left the document, which
 * a StrictMode simulated detach never does; WebGL calls on a lost context, including dispose()'s
 * deletes, are no-ops.
 */
export const createPaperShaderReleaseRef = (target: { current: PaperShaderElement | null }) => (
    (element: PaperShaderElement | null) => {
        target.current = element;
        if (!element) return undefined;
        return () => {
            target.current = null;
            const canvas = element.paperShaderMount?.canvasElement;
            if (!canvas) return;
            const gl = canvas.getContext('webgl2');
            queueMicrotask(() => {
                if (!gl || canvas.isConnected || gl.isContextLost()) return;
                gl.getExtension('WEBGL_lose_context')?.loseContext();
            });
        };
    }
);

/** How long a lost context gets to come back on its own before the shader is rebuilt. */
export const PAPER_SHADER_RESTORE_RETRY_MS = 2000;

/** Listeners for one paper shader canvas's WebGL context. */
export interface PaperShaderContextWatch {
    /** The context was lost: the canvas draws nothing until it is restored or rebuilt. */
    onLost?: () => void;
    /** The context came back: the shader's GL resources are gone with it, so it must be rebuilt. */
    onRestored?: () => void;
}

/**
 * Watches one paper shader's canvas for a lost WebGL context, so a loss does not leave the
 * background black for good.
 *
 * Opening the lyric style window holds the most canvases on the page at once (the playing page's
 * shaders, the window's own sample, and the style pictures made one after another), and the
 * browser answers by losing the oldest context, which is the playing page's (pictureTurns.ts:
 * 16 contexts, the oldest lost). paper-shaders listens for neither event, so without this the
 * loss is final: the canvas stays blank behind the lyrics until the page reloads.
 *
 * Preventing the loss is what lets the browser restore the context at all; without the
 * preventDefault the loss can never be undone. Returns a cleanup that removes both listeners.
 */
export const watchPaperShaderContext = (
    canvas: Pick<HTMLCanvasElement, 'addEventListener' | 'removeEventListener'>,
    watch: PaperShaderContextWatch,
): (() => void) => {
    const onLost = (event: Event) => {
        event.preventDefault();
        watch.onLost?.();
    };
    const onRestored = () => watch.onRestored?.();
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    return () => {
        canvas.removeEventListener('webglcontextlost', onLost);
        canvas.removeEventListener('webglcontextrestored', onRestored);
    };
};

/**
 * Whether any of the given canvases still has no WebGL context to draw with. Only call it on
 * canvases known to hold a webgl2 context already (a paper shader's mount): asking a canvas
 * that has none for one would create it.
 */
export const anyPaperShaderContextLost = (
    canvases: ReadonlyArray<Pick<HTMLCanvasElement, 'getContext'> | null | undefined>,
): boolean => canvases.some(canvas => {
    const gl = canvas?.getContext('webgl2');
    return gl?.isContextLost() ?? false;
});
