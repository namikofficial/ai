import { Component, type ErrorInfo, type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

class FrontendErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("AI Workbench frontend error", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <main
          style={{
            padding: "2rem",
            fontFamily: "system-ui",
            color: "#e2e8f0",
            background: "#07111f",
            minHeight: "100vh",
          }}
        >
          <h1>AI Workbench could not render</h1>
          <p>{this.state.error.message}</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}

const root = createRoot(document.getElementById("root") as HTMLElement);
root.render(
  <StrictMode>
    <FrontendErrorBoundary>
      <App />
    </FrontendErrorBoundary>
  </StrictMode>
);
