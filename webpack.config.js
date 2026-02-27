const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

module.exports = {
  entry: {
    background: './src/background/background.js',
    offscreen: './src/offscreen/offscreen.js',
    'whisper-worker': './src/worker/whisper-worker.js',
    popup: './src/popup/popup.js',
    content: './src/content/content.js',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true,
  },
  module: {
    rules: [
      {
        test: /\.css$/,
        use: [MiniCssExtractPlugin.loader, 'css-loader'],
      },
    ],
  },
  plugins: [
    new MiniCssExtractPlugin({
      filename: '[name].css',
    }),
    new CopyPlugin({
      patterns: [
        { from: 'manifest.json', to: 'manifest.json' },
        { from: 'icons', to: 'icons' },
        { from: 'src/popup/popup.html', to: 'popup.html' },
        { from: 'src/offscreen/offscreen.html', to: 'offscreen.html' },
        { from: 'src/content/content.css', to: 'content.css' },
      ],
    }),
  ],
  resolve: {
    extensions: ['.js'],
  },
  optimization: {
    minimize: false, // Keep readable for debugging
  },
  devtool: 'cheap-source-map',
  // Chrome extensions need specific worker handling
  target: 'web',
};
