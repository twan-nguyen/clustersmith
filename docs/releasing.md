# Phát hành ClusterSmith

Ghi chú vận hành cho chủ repo. Người dùng cài app bằng Homebrew:

```bash
brew install --cask twan-nguyen/tap/clustersmith
```

## Phát hành bản mới

1. Commit và push mọi thay đổi lên `main`.
2. Tạo tag phiên bản rồi push tag:

   ```bash
   git tag v0.1.0 && git push origin v0.1.0
   ```

3. Theo dõi CI. Bản build universal mất khoảng 10–15 phút:

   ```bash
   gh run watch --repo twan-nguyen/clustersmith
   ```

4. Kiểm tra cask đã trỏ sang bản mới, rồi cập nhật trên máy:

   ```bash
   gh api repos/twan-nguyen/homebrew-tap/contents/Casks/clustersmith.rb --jq .content | base64 -d | grep 'version "'
   brew update && brew upgrade --cask clustersmith
   ```

Workflow [release.yml](../.github/workflows/release.yml) làm lần lượt các bước sau:
- Build `ClusterSmith.app` universal, chạy được cả trên Apple Silicon lẫn Intel. App được ký ad-hoc.
- Nén app thành `ClusterSmith-X.Y.Z.zip` và tạo GitHub Release.
- Ghi lại `Casks/clustersmith.rb` trong [homebrew-tap](https://github.com/twan-nguyen/homebrew-tap) với phiên bản và `sha256` mới.

### Quy tắc

- Tag phải có dạng `vX.Y.Z`. Tag sai dạng làm CI dừng ngay.
- Số phiên bản lấy từ tag, nên không cần sửa `version` trong `tauri.conf.json` hay `Cargo.toml`.
- App không có chữ ký Developer ID và không được notarize. Cask tự gỡ cờ quarantine sau khi cài, nên Gatekeeper không chặn. Nếu tải zip bằng trình duyệt thì phải gỡ tay: `xattr -dr com.apple.quarantine /Applications/ClusterSmith.app`.

### Khi phát hành hỏng

Xem log bằng `gh run view --log-failed --repo twan-nguyen/clustersmith`. Sửa lỗi, rồi xoá release và tag cũ trước khi gắn lại:

```bash
gh release delete v0.1.0 --cleanup-tag --yes --repo twan-nguyen/clustersmith
git tag -d v0.1.0
git tag v0.1.0 && git push origin v0.1.0
```

## Deploy key cho tap

CI đẩy cask lên tap bằng một deploy key có quyền ghi. Secret `TAP_DEPLOY_KEY` của repo clustersmith giữ khoá riêng, còn repo `homebrew-tap` giữ khoá công khai. Khoá này tách khỏi khoá của Twanotch, nên thu hồi khoá này không ảnh hưởng tới repo kia.

Tạo hoặc thay khoá:

```bash
ssh-keygen -t ed25519 -N "" -C "clustersmith release" -f ~/clustersmith-tap-key
gh repo deploy-key add ~/clustersmith-tap-key.pub --repo twan-nguyen/homebrew-tap --allow-write --title "clustersmith release"
gh secret set TAP_DEPLOY_KEY --repo twan-nguyen/clustersmith < ~/clustersmith-tap-key
rm ~/clustersmith-tap-key ~/clustersmith-tap-key.pub
```

Khoá không lưu lại trên máy nào. Khi mất khoá, chỉ cần xoá deploy key cũ trong Settings > Deploy keys của `homebrew-tap` rồi tạo lại bằng các lệnh trên.

## Build trên máy, không qua phát hành

```bash
pnpm tauri build --bundles app
```

App nằm ở `src-tauri/target/release/bundle/macos/ClusterSmith.app`. Muốn build bản universal như CI thì chạy `rustup target add x86_64-apple-darwin` một lần, rồi thêm `--target universal-apple-darwin`.

## Ghi chú

- App mở từ Finder hoặc Dock chỉ nhận PATH tối thiểu của launchd. Vì vậy, lúc khởi động app chạy login shell của người dùng để lấy PATH ([login_path.rs](../src-tauri/src/login_path.rs)), nhờ đó các plugin `exec` trong kubeconfig như `aws`, `gke-gcloud-auth-plugin` và `kubelogin` vẫn chạy được. Shell chạy quá 3 giây thì app giữ nguyên PATH cũ.
- `brew uninstall --cask --zap clustersmith` xoá cả cài đặt, dữ liệu WebView và chỗ đã lưu cho từng cluster.
