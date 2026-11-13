import { describe, expect, it, vi } from 'vitest';
import type { PaperShaderElement } from '@paper-design/shaders';
import {
    anyPaperShaderContextLost,
    createPaperShaderReleaseRef,
    PAPER_SHADER_CONTEXT_ATTRIBUTES,
    watchPaperShaderContext,
} from '@/utils/paperShaderContext';

// test/unit/utils/paperShaderContext.test.ts
// The latent background's paper shaders must give their WebGL context back when they unmount,
// but only once the canvas has left the document (a StrictMode simulated detach keeps it).
// They must also survive a context the browser takes while the lyric style window holds the
// most canvases: the loss is prevented (or the browser can never restore it) and the shader is
// rebuilt once the context comes back, or, if it never does, once it is still lost a moment later.

const fakeShaderElement = (isConnected: boolean) => {
    const loseContext = vi.fn();
    const gl = { isContextLost: () => false, getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext } : null) };
    const canvas = { isConnected, getContext: vi.fn(() => gl) };
    const element = { paperShaderMount: { canvasElement: canvas } } as unknown as PaperShaderElement;
    return { element, canvas, loseContext };
};

const flushMicrotasks = () => new Promise<void>(resolve => queueMicrotask(resolve));

describe('createPaperShaderReleaseRef', () => {
    it('tracks the element and loses the context once the canvas has left the document', async () => {
        const target: { current: PaperShaderElement | null } = { current: null };
        const { element, canvas, loseContext } = fakeShaderElement(false);
        const cleanup = createPaperShaderReleaseRef(target)(element);
        expect(target.current).toBe(element);
        cleanup?.();
        expect(target.current).toBeNull();
        expect(canvas.getContext).toHaveBeenCalledWith('webgl2');
        await flushMicrotasks();
        expect(loseContext).toHaveBeenCalledTimes(1);
    });

    it('keeps the context while the canvas is still in the document', async () => {
        const { element, loseContext } = fakeShaderElement(true);
        createPaperShaderReleaseRef({ current: null })(element)?.();
        await flushMicrotasks();
        expect(loseContext).not.toHaveBeenCalled();
    });

    it('does nothing when the shader mount was never created', async () => {
        const element = {} as PaperShaderElement;
        expect(() => createPaperShaderReleaseRef({ current: null })(element)?.()).not.toThrow();
        await flushMicrotasks();
    });

    it('asks for a context without MSAA or depth', () => {
        expect(PAPER_SHADER_CONTEXT_ATTRIBUTES).toEqual({ antialias: false, depth: false });
    });
});

describe('watchPaperShaderContext', () => {
    const fakeCanvas = () => new EventTarget() as unknown as HTMLCanvasElement;

    it('prevents the loss, so the browser can restore the context at all, and reports it', () => {
        const onLost = vi.fn();
        const canvas = fakeCanvas();
        watchPaperShaderContext(canvas, { onLost });
        const event = new Event('webglcontextlost', { cancelable: true });
        canvas.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(onLost).toHaveBeenCalledTimes(1);
    });

    it('reports a restored context, so the shader can be rebuilt on it', () => {
        const onRestored = vi.fn();
        const canvas = fakeCanvas();
        watchPaperShaderContext(canvas, { onRestored });
        canvas.dispatchEvent(new Event('webglcontextrestored'));
        expect(onRestored).toHaveBeenCalledTimes(1);
    });

    it('stops reporting after cleanup', () => {
        const onLost = vi.fn();
        const onRestored = vi.fn();
        const canvas = fakeCanvas();
        const cleanup = watchPaperShaderContext(canvas, { onLost, onRestored });
        cleanup();
        canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
        canvas.dispatchEvent(new Event('webglcontextrestored'));
        expect(onLost).not.toHaveBeenCalled();
        expect(onRestored).not.toHaveBeenCalled();
    });
});

describe('anyPaperShaderContextLost', () => {
    const fakeCanvasWith = (lost: boolean | null) => ({
        getContext: vi.fn(() => (lost === null ? null : { isContextLost: () => lost })),
    }) as unknown as Pick<HTMLCanvasElement, 'getContext'>;

    it('is true while any canvas reports its context lost', () => {
        expect(anyPaperShaderContextLost([fakeCanvasWith(false), fakeCanvasWith(true)])).toBe(true);
    });

    it('is false when no canvas is lost, missing, or without a context', () => {
        expect(anyPaperShaderContextLost([fakeCanvasWith(false), null, undefined, fakeCanvasWith(null)])).toBe(false);
    });
});
