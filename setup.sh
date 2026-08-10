#!/bin/bash
# 商厨线索管理系统 - 阿里云部署脚本
# 用法: bash setup.sh

echo "================================"
echo "  商厨线索管理系统 一键部署"
echo "================================"

# 1. 安装 Node.js (如已安装则跳过)
if ! command -v node &> /dev/null; then
  echo "📦 安装 Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# 2. 安装 pm2
if ! command -v pm2 &> /dev/null; then
  echo "📦 安装 pm2..."
  npm install -g pm2
fi

# 3. 安装依赖
echo "📦 安装项目依赖..."
npm install

# 4. 创建必要目录
mkdir -p data logs

# 5. 启动服务
echo "🚀 启动服务..."
pm2 delete lead-system 2>/dev/null
pm2 start ecosystem.config.js
pm2 save
pm2 startup

echo ""
echo "✅ 部署完成！"
echo "📊 查看状态: pm2 status"
echo "📋 查看日志: pm2 logs lead-system"
echo "🔄 重启服务: pm2 restart lead-system"
echo ""
echo "⚠  接下来你需要在阿里云安全组中开放 3456 端口"
