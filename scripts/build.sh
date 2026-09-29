cargo build --release
cargo build --release -p astrcode-server --bin astrcode-http-server

cd frontend/
npm run build
