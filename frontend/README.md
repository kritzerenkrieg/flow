# Web frontend for Flow

> The todo app to organize your life.

[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue.svg)](LICENSE)

This is the web frontend for Flow, written in Vue.js.

For general information about the project, refer to the top-level readme of this repo.

## Project setup

```shell
pnpm install
```

### Development

#### Define backend server

You can develop the web front end against any accessible backend, for example your local instance at http://127.0.0.1:3456

In order to do so, you need to set the `DEV_PROXY` env variable. The recommended way to do so is to:

- Copy `.env.local.example` as `.env.local`
- Uncomment the `DEV_PROXY` line
- Set the backend url you want to use

In the end, it should look like `DEV_PROXY=http://127.0.0.1:3456` if you work against a local backend.


#### Start dev server (compiles and hot-reloads)

```shell
pnpm run dev
```

### Compiles and minifies for production

```shell
pnpm run build
```

### Lints and fixes files

```shell
pnpm run lint
```

## License

This project is licensed under the AGPL-3.0-or-later license. See the [LICENSE](LICENSE) file for details.
