# 前端必须先于 Rust 构建：astrcode-server 在编译期把 frontend/dist 内嵌进二进制。
cd frontend/
npm run build
cd ..

cargo build --release -p astrcode-server --bin astrcode-http-server
