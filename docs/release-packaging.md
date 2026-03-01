# OpenCarapace 发布与部署（brew / apt / pacman / curl）

## 1. 发布产物（自动生成）

打 `vX.Y.Z` tag 后，`release-packages` workflow 会生成并上传：

- `opencarapace_<version>_darwin_amd64.tar.gz`
- `opencarapace_<version>_darwin_arm64.tar.gz`
- `opencarapace_<version>_linux_amd64.tar.gz`
- `opencarapace_<version>_linux_arm64.tar.gz`
- `opencarapace_<version>_linux_amd64.deb`
- `opencarapace_<version>_linux_arm64.deb`
- `opencarapace_<version>_linux_amd64.pkg.tar.zst`
- `opencarapace_<version>_linux_arm64.pkg.tar.zst`
- `checksums.txt`
- `opencarapace.rb`（Homebrew formula 模板）

## 2. 一行安装（curl）

默认安装到 `/usr/local/bin`：

```bash
curl -fsSL https://raw.githubusercontent.com/zqqqqz2000/OpenCarapace/main/install.sh | bash
```

指定版本（例如 `v0.1.0`）：

```bash
curl -fsSL https://raw.githubusercontent.com/zqqqqz2000/OpenCarapace/main/install.sh | OPENCARAPACE_VERSION=v0.1.0 bash
```

安装到用户目录：

```bash
curl -fsSL https://raw.githubusercontent.com/zqqqqz2000/OpenCarapace/main/install.sh | OPENCARAPACE_INSTALL_DIR=$HOME/.local/bin bash
```

## 3. Homebrew 发布

1. 创建/使用 tap 仓库（例如 `zqqqqz2000/homebrew-tap`）。
2. 将 release 里生成的 `opencarapace.rb` 放到 tap 仓库的 `Formula/opencarapace.rb`。
3. 提交后可安装：

```bash
brew tap zqqqqz2000/tap
brew install opencarapace
```

## 4. apt 发布与安装

### 4.1 最简方式（无需 apt 仓库）

```bash
curl -LO https://github.com/zqqqqz2000/OpenCarapace/releases/download/v0.1.0/opencarapace_0.1.0_linux_amd64.deb
sudo apt install ./opencarapace_0.1.0_linux_amd64.deb
```

### 4.2 完整 apt 仓库（可选）

建议用托管仓库服务（如 Cloudsmith / Aptly）托管 `.deb`，再给用户 `apt source` 配置和 GPG key。

## 5. pacman 发布与安装

### 5.1 最简方式（无需 pacman 仓库）

```bash
curl -LO https://github.com/zqqqqz2000/OpenCarapace/releases/download/v0.1.0/opencarapace_0.1.0_linux_amd64.pkg.tar.zst
sudo pacman -U ./opencarapace_0.1.0_linux_amd64.pkg.tar.zst
```

### 5.2 完整 pacman 仓库（可选）

可在你们自己的仓库服务器上使用 `repo-add` 维护数据库后分发。

## 6. 手动本地打包（不走 CI）

要求：`bun` + `nfpm`。

```bash
./scripts/release/build-artifacts.sh
./scripts/release/generate-homebrew-formula.sh
```

产物目录：`dist/release/`。
