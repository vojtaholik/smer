class Smer < Formula
  desc "Local, event-driven work memory"
  homepage "https://github.com/vojtaholik/smer"
  url "https://github.com/vojtaholik/smer/releases/download/v0.1.0/smer-darwin-arm64.tar.gz"
  version "0.1.0"
  sha256 "e6610c2cb2dd974af3d0f2f420c63c9063138bfb75a62b09e23f0ad41e93b9fa"
  license "MIT"

  depends_on :macos

  def install
    bin.install "smer"
  end

  test do
    assert_match "smer 0.1.0", shell_output("#{bin}/smer version")
  end
end
