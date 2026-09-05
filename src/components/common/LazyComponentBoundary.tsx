import { Component, Suspense, type ErrorInfo, type ReactNode } from "react";
import { waitForActiveAIProviderExecutions } from "../../services/aiCallAttemptLifecycleService";

type LazyLoadErrorBoundaryProps = {
  children: ReactNode;
  errorMessage: string;
  retryLabel: string;
  resetKey?: string;
};

type LazyLoadErrorBoundaryState = {
  failed: boolean;
};

class LazyLoadErrorBoundary extends Component<
  LazyLoadErrorBoundaryProps,
  LazyLoadErrorBoundaryState
> {
  state: LazyLoadErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): LazyLoadErrorBoundaryState {
    return { failed: true };
  }

  componentDidUpdate(previousProps: LazyLoadErrorBoundaryProps) {
    if (this.state.failed && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // The visible local boundary deliberately avoids exposing technical details.
  }

  private reloadAfterCanonicalAISettlement = async () => {
    await waitForActiveAIProviderExecutions();
    window.location.reload();
  };

  render() {
    if (this.state.failed) {
      return (
        <section className="empty-state" role="alert">
          <p>{this.props.errorMessage}</p>
          <button type="button" onClick={() => void this.reloadAfterCanonicalAISettlement()}>
            {this.props.retryLabel}
          </button>
        </section>
      );
    }
    return this.props.children;
  }
}

export function LazyComponentBoundary({
  children,
  loadingMessage,
  errorMessage,
  retryLabel,
  resetKey
}: {
  children: ReactNode;
  loadingMessage: string;
  errorMessage: string;
  retryLabel: string;
  resetKey?: string;
}) {
  return (
    <LazyLoadErrorBoundary
      errorMessage={errorMessage}
      retryLabel={retryLabel}
      resetKey={resetKey}
    >
      <Suspense fallback={<section className="empty-state" role="status">{loadingMessage}</section>}>
        {children}
      </Suspense>
    </LazyLoadErrorBoundary>
  );
}
