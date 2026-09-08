// This demonstration never needs a model or a tracing service. Override tracing
// flags for this process before importing the framework, including inherited ones.
process.env.LANGSMITH_TRACING = 'false';
process.env.LANGCHAIN_TRACING = '';
process.env.LANGCHAIN_TRACING_V2 = 'false';
process.env.LANGSMITH_TRACING_V2 = 'false';
process.env.LANGSMITH_OTEL_ENABLED = 'false';
process.env.LANGCHAIN_OTEL_ENABLED = 'false';
process.env.OTEL_ENABLED = 'false';
