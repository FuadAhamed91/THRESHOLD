import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[THRESHOLD] UI error', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid h-full place-items-center bg-cream-100 p-6 text-center">
        <div className="glass max-w-md rounded-2xl p-6">
          <div className="text-lg font-semibold">Something went wrong</div>
          <p className="mt-2 text-sm text-text-2">{this.state.error.message}</p>
          <button className="btn btn-primary mt-4" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
