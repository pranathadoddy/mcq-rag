# My Node.js TypeScript Project

This project is built using Node.js and TypeScript. It includes several scripts for running a server, evaluating, vectorizing data, and deleting data.

## 📦 Prerequisites

- Node.js v16 or higher
- npm or yarn
- TypeScript
- ts-node

Install the dependencies:

```bash
npm install
```

````

## 🚀 Available Scripts

### `npm run server`

Runs the main server (`src/server.ts`):

```bash
npm run server
```

### `npm run evaluate`

Runs the evaluation script (`src/evaluator.ts`):

```bash
npm run evaluate
```

### `npm run vectorize`

Runs the vectorizer with increased memory allocation (8GB). Useful for processing large datasets.

```bash
npm run vectorize
```

> 💡 On **Windows**, you may need to replace `set` with `cross-env`. Install it with:
>
> ```bash
> npm install --save-dev cross-env
> ```
>
> Then change the script in `package.json` to:
>
> ```json
> "vectorize": "cross-env NODE_OPTIONS=--max-old-space-size=8192 ts-node src/index.ts"
> ```

### `npm run delete`

Runs the deletion script (`src/delete.ts`):

```bash
npm run delete
```
````
